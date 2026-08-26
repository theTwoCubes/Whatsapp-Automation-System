import { verifyPassword, hashPassword } from '../auth.js';
import { handToHuman, handToBot } from '../handoff.js';
import { getEditableSettings, editableKeys, invalidateSettings, getBranding } from '../settings.js';
import { createRateLimiter } from '../ratelimit.js';
import {
  listTopics,
  upsertTopic,
  updateTopic,
  listKnowledgeByScope,
  setKnowledgeActive,
  deleteKnowledgeUnit,
} from '../knowledge/topics.js';
import { addKnowledgeUnit } from '../knowledge/writer.js';
import { ingestText } from '../knowledge/ingestion.js';
import {
  getAgentByEmail,
  listConversations,
  getConversationById,
  getConversationMessages,
  listTemplates,
  syncTemplates,
  recordOutbound,
  cancelDrips,
  markAgentReplied,
  setSettings,
  listAgents,
  createAgent,
  deleteAgent,
  overview,
  campaignStats,
  linkCampaignTopic,
  addMediaAsset,
  listMediaAssets,
  getMediaAsset,
  deleteMediaAsset,
  addAudit,
  listAudit,
  getMessageRaw,
} from '../db/repo.js';
import { saveMediaAsset } from '../knowledge/media.js';

// Pulls the media id out of an inbound message payload.
function mediaIdFromRaw(raw) {
  if (!raw) return null;
  for (const kind of ['image', 'document', 'video', 'audio', 'sticker']) {
    if (raw[kind]?.id) return raw[kind].id;
  }
  return null;
}

// Reject a path id that is not a positive integer with a 400 instead of letting
// it reach Postgres and fail as a 500.
const idParams = {
  params: {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[0-9]+$' } },
    required: ['id'],
  },
};

function mediaKind(mime) {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

// The 24 hour service window is open while the last inbound was under 24 hours
// ago, which we track as window_expires_at.
function windowOpen(conversation) {
  return Boolean(conversation.window_expires_at) && new Date(conversation.window_expires_at) > new Date();
}

// Builds the body parameters for a template send from a list of values.
function bodyComponents(params) {
  if (!Array.isArray(params) || params.length === 0) return undefined;
  return [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }];
}

// All console endpoints live under /api. Everything except login requires a
// valid agent token.
export function registerApi(app, deps) {
  const { pool, meta, realtime } = deps;
  const loginLimiter = createRateLimiter({ max: 8, windowMs: 60000 });

  const auth = async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  // Records who did what, best effort so it never blocks the action.
  const audit = (req, action, target, detail) =>
    addAudit(pool, { actor: req.user?.email, action, target, detail }).catch((err) =>
      req.log.warn({ err }, 'failed to write audit entry'),
    );

  // An agent replying to a pending handoff has, in effect, just accepted it,
  // so claim it for them instead of leaving it looking unclaimed once they
  // have already started answering.
  const claimIfPending = (conversation, email) =>
    conversation.state === 'pending' ? handToHuman(pool, conversation.id, email) : Promise.resolve();

  app.post('/api/login', async (req, reply) => {
    const limit = loginLimiter(req.ip);
    if (!limit.ok) {
      return reply.code(429).send({ error: 'too many attempts, try again shortly', retryAfter: limit.retryAfter });
    }
    const { email, password } = req.body ?? {};
    const agent = email ? await getAgentByEmail(pool, email) : null;
    if (!agent || !verifyPassword(password ?? '', agent.password_hash)) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    const token = app.jwt.sign({ id: agent.id, email: agent.email }, { expiresIn: '12h' });
    return { token, agent: { id: agent.id, email: agent.email, name: agent.name } };
  });

  app.get('/api/conversations', { preHandler: auth }, async () => ({
    conversations: await listConversations(pool),
  }));

  app.get('/api/conversations/:id', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    const messages = await getConversationMessages(pool, req.params.id);
    return {
      conversation: {
        ...conversation,
        window_open: windowOpen(conversation),
      },
      messages,
    };
  });

  app.post('/api/conversations/:id/messages', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const body = (req.body?.body ?? '').trim();
    if (!body) return reply.code(400).send({ error: 'body is required' });
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });

    // Outside the window a free text message would be rejected by Meta with
    // error 131047, so block it here and tell the agent to use a template.
    if (!windowOpen(conversation)) {
      return reply.code(409).send({
        error: 'The 24 hour window has closed. You can only send an approved template now.',
        code: 'window_closed',
      });
    }

    try {
      const wamid = await meta.sendText(conversation.wa_id, body);
      if (wamid) await recordOutbound(pool, { conversationId: conversation.id, waMessageId: wamid, body });
      await claimIfPending(conversation, req.user.email);
      await markAgentReplied(pool, conversation.id);
      realtime.emit({ type: 'refresh', conversationId: conversation.id });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/conversations/:id/template', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'template name is required' });
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });

    try {
      const components = bodyComponents(req.body?.params);
      const wamid = await meta.sendTemplate(conversation.wa_id, name, deps.config.dripLanguage, components);
      if (wamid) {
        await recordOutbound(pool, {
          conversationId: conversation.id,
          waMessageId: wamid,
          type: 'template',
          body: `[template] ${name}`,
        });
      }
      await claimIfPending(conversation, req.user.email);
      await markAgentReplied(pool, conversation.id);
      await audit(req, 'template sent', `conversation ${conversation.id}`, name);
      realtime.emit({ type: 'refresh', conversationId: conversation.id });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/conversations/:id/takeover', { preHandler: auth, schema: idParams }, async (req) => {
    await handToHuman(pool, req.params.id, req.user.email);
    await cancelDrips(pool, req.params.id);
    await audit(req, 'takeover', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  app.post('/api/conversations/:id/handback', { preHandler: auth, schema: idParams }, async (req) => {
    await handToBot(pool, req.params.id);
    await audit(req, 'handback', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  // Accepting or rejecting a pending handoff. A handoff the bot or a lead
  // queued sits pending until an agent claims it or sends it back to the bot.
  app.post('/api/conversations/:id/accept', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    if (conversation.state !== 'pending') {
      return reply.code(409).send({ error: 'this conversation is not waiting on a handoff' });
    }
    await handToHuman(pool, req.params.id, req.user.email);
    await audit(req, 'handoff accepted', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  app.post('/api/conversations/:id/reject', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    if (conversation.state !== 'pending') {
      return reply.code(409).send({ error: 'this conversation is not waiting on a handoff' });
    }
    await handToBot(pool, req.params.id);
    await audit(req, 'handoff rejected', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  app.get('/api/templates', { preHandler: auth }, async () => ({ templates: await listTemplates(pool) }));

  // Pulls the latest approved templates from Meta so the console list is current.
  app.post('/api/templates/sync', { preHandler: auth }, async (_req, reply) => {
    try {
      const templates = await meta.fetchTemplates();
      await syncTemplates(pool, templates);
      return { synced: templates.length, templates: await listTemplates(pool) };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Overview stats.
  app.get('/api/overview', { preHandler: auth }, async () => ({ overview: await overview(pool) }));

  // Where leads actually came from: one row per ad campaign plus an organic
  // bucket for everyone who arrived with no click to whatsapp referral.
  app.get('/api/campaigns', { preHandler: auth }, async () => campaignStats(pool));

  // Links a campaign to a knowledge Topic, so replies for that campaign's
  // leads get boosted toward the right service pack.
  app.put('/api/campaigns/:id', { preHandler: auth, schema: idParams }, async (req) => {
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    await linkCampaignTopic(pool, req.params.id, topicId);
    await audit(req, 'campaign topic linked', `campaign ${req.params.id}`);
    return { ok: true };
  });

  // Editable settings.
  app.get('/api/settings', { preHandler: auth }, async () => ({
    settings: await getEditableSettings(pool, deps.config),
  }));

  app.put('/api/settings', { preHandler: auth }, async (req) => {
    const entries = {};
    for (const key of editableKeys) {
      if (req.body && key in req.body) entries[key] = req.body[key];
    }
    await setSettings(pool, entries);
    invalidateSettings();
    await audit(req, 'settings updated', null, Object.keys(entries).join(', '));
    return { settings: await getEditableSettings(pool, deps.config) };
  });

  app.get('/api/audit', { preHandler: auth }, async () => ({ audit: await listAudit(pool, 150) }));

  // Public branding for the console shell, no auth so the login page can theme.
  app.get('/api/branding', async () => ({ branding: await getBranding(pool, deps.config) }));

  // Create a template from the console. It still needs Meta approval before use.
  app.post('/api/templates/create', { preHandler: auth }, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    const bodyText = (req.body?.bodyText ?? '').trim();
    if (!name || !bodyText) return reply.code(400).send({ error: 'name and body are required' });
    try {
      await meta.createTemplate({
        name,
        category: req.body?.category,
        language: req.body?.language,
        bodyText,
      });
      await audit(req, 'template created', name);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Streams media a lead sent, so the console can show it.
  app.get('/api/messages/:id/media', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const message = await getMessageRaw(pool, req.params.id);
    const mediaId = mediaIdFromRaw(message?.raw);
    if (!mediaId) return reply.code(404).send({ error: 'no media on this message' });
    try {
      const url = await meta.getMediaUrl(mediaId);
      const { buffer, contentType } = await meta.downloadMedia(url);
      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'private, max-age=300');
      return reply.send(buffer);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // WhatsApp business profile, straight through to Meta.
  app.get('/api/profile', { preHandler: auth }, async (_req, reply) => {
    try {
      return { profile: await meta.getBusinessProfile() };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.put('/api/profile', { preHandler: auth }, async (req, reply) => {
    const allowed = ['about', 'address', 'description', 'email', 'vertical', 'websites'];
    const fields = {};
    for (const key of allowed) {
      if (req.body && key in req.body) fields[key] = req.body[key];
    }
    try {
      await meta.updateBusinessProfile(fields);
      return { profile: await meta.getBusinessProfile() };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Knowledge base. Tiered: base is the shared brain, topic is per service.

  // Topics.
  app.get('/api/topics', { preHandler: auth }, async () => ({ topics: await listTopics(pool) }));

  app.post('/api/topics', { preHandler: auth }, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    const slug = (req.body?.slug ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const description = (req.body?.description ?? '').trim() || null;
    if (!name || !slug) return reply.code(400).send({ error: 'name and slug are required' });
    const topic = await upsertTopic(pool, { slug, name, description });
    await audit(req, 'topic added', slug);
    return { topic };
  });

  app.put('/api/topics/:id', { preHandler: auth, schema: idParams }, async (req) => {
    await updateTopic(pool, req.params.id, {
      name: req.body?.name,
      description: req.body?.description,
      active: req.body?.active,
    });
    await audit(req, 'topic updated', `topic ${req.params.id}`);
    return { ok: true };
  });

  // Knowledge listing per scope. scope=base or scope=topic&topicId=N.
  app.get('/api/knowledge', { preHandler: auth }, async (req) => {
    const scope = (req.query?.scope ?? 'base').trim();
    const topicId = req.query?.topicId ? Number(req.query.topicId) : null;
    return { knowledge: await listKnowledgeByScope(pool, { scope, topicId }) };
  });

  // Add a single knowledge unit, dedup gated. Body: { title, content, scope, topicId }.
  app.post('/api/knowledge', { preHandler: auth }, async (req, reply) => {
    const title = (req.body?.title ?? '').trim();
    const content = (req.body?.content ?? '').trim();
    const scope = (req.body?.scope ?? 'base').trim();
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    if (!title || !content) return reply.code(400).send({ error: 'title and content are required' });
    if (scope === 'topic' && !topicId) return reply.code(400).send({ error: 'topicId is required for scope=topic' });
    try {
      const res = await addKnowledgeUnit(pool, deps.embeddings, { title, content, scope, topicId, source: 'manual' });
      await audit(req, res.added ? 'knowledge added' : 'knowledge duplicate skipped', title);
      return res;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Ingest raw text (an FAQ paste, a doc) into atomic deduped units.
  app.post('/api/knowledge/ingest', { preHandler: auth }, async (req, reply) => {
    const text = (req.body?.text ?? '').trim();
    const scope = (req.body?.scope ?? 'base').trim();
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (scope === 'topic' && !topicId) return reply.code(400).send({ error: 'topicId is required for scope=topic' });
    try {
      const res = await ingestText(pool, deps.ai, deps.embeddings, text, { scope, topicId });
      await audit(req, 'knowledge ingested', scope === 'topic' ? `topic ${topicId}` : 'base', `added ${res.added}, skipped ${res.skipped}`);
      return res;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.put('/api/knowledge/:id', { preHandler: auth, schema: idParams }, async (req) => {
    if (typeof req.body?.active === 'boolean') {
      await setKnowledgeActive(pool, req.params.id, req.body.active);
    }
    return { ok: true };
  });

  app.delete('/api/knowledge/:id', { preHandler: auth, schema: idParams }, async (req) => {
    await deleteKnowledgeUnit(pool, req.params.id);
    await audit(req, 'knowledge deleted', `unit ${req.params.id}`);
    return { ok: true };
  });

  // Console agents.
  app.get('/api/agents', { preHandler: auth }, async () => ({ agents: await listAgents(pool) }));

  app.post('/api/agents', { preHandler: auth }, async (req, reply) => {
    const email = (req.body?.email ?? '').trim().toLowerCase();
    const password = req.body?.password ?? '';
    if (!email || password.length < 6) {
      return reply.code(400).send({ error: 'email and a password of at least 6 characters are required' });
    }
    await createAgent(pool, { email, name: req.body?.name ?? null, passwordHash: hashPassword(password) });
    await audit(req, 'agent added', email);
    return { ok: true };
  });

  app.delete('/api/agents/:id', { preHandler: auth, schema: idParams }, async (req, reply) => {
    if (String(req.user.id) === String(req.params.id)) {
      return reply.code(400).send({ error: 'you cannot remove your own login' });
    }
    await deleteAgent(pool, req.params.id);
    await audit(req, 'agent removed', `agent ${req.params.id}`);
    return { ok: true };
  });

  // Media library. Assets are tagged to a topic with a description so the bot
  // can find the right one by meaning, not just dump everything under a topic.
  app.get('/api/media', { preHandler: auth }, async (req) => {
    const topicId = req.query?.topicId ? Number(req.query.topicId) : null;
    return { media: await listMediaAssets(pool, { topicId }) };
  });

  app.post('/api/media', { preHandler: auth }, async (req, reply) => {
    let file = null;
    let topicId = null;
    let description = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          file = { buffer: await part.toBuffer(), mimetype: part.mimetype, filename: part.filename };
        } else if (part.fieldname === 'topicId') {
          topicId = part.value ? Number(part.value) : null;
        } else if (part.fieldname === 'description') {
          description = part.value || null;
        }
      }
    } catch {
      // fall through to the missing file check below
    }
    if (!file) return reply.code(400).send({ error: 'a file is required' });

    try {
      const kind = mediaKind(file.mimetype);
      const metaMediaId = await meta.uploadMedia(file.buffer, file.mimetype, file.filename);
      const id = await saveMediaAsset(pool, deps.embeddings, {
        metaMediaId,
        filename: file.filename,
        mimeType: file.mimetype,
        kind,
        topicId,
        description,
      });
      await audit(req, 'media uploaded', `asset ${id}`, file.filename);
      return { id, kind, filename: file.filename };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.delete('/api/media/:id', { preHandler: auth, schema: idParams }, async (req) => {
    await deleteMediaAsset(pool, req.params.id);
    await audit(req, 'media removed', `asset ${req.params.id}`);
    return { ok: true };
  });

  app.post('/api/conversations/:id/media', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    if (!windowOpen(conversation)) {
      return reply.code(409).send({ error: 'The 24 hour window has closed. Send an approved template instead.', code: 'window_closed' });
    }
    const asset = await getMediaAsset(pool, req.body?.assetId);
    if (!asset) return reply.code(404).send({ error: 'media not found' });

    try {
      const caption = (req.body?.caption ?? '').trim() || undefined;
      const wamid = await meta.sendMedia(conversation.wa_id, asset.kind, {
        id: asset.meta_media_id,
        caption,
        filename: asset.filename,
      });
      if (wamid) {
        await recordOutbound(pool, {
          conversationId: conversation.id,
          waMessageId: wamid,
          type: asset.kind,
          body: caption || `[${asset.kind}] ${asset.filename ?? ''}`.trim(),
          mediaAssetId: asset.id,
        });
      }
      await claimIfPending(conversation, req.user.email);
      await markAgentReplied(pool, conversation.id);
      await audit(req, 'media sent', `conversation ${conversation.id}`, asset.filename);
      realtime.emit({ type: 'refresh', conversationId: conversation.id });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Live updates. The token comes in as a query param since a browser websocket
  // cannot set an auth header.
  app.get('/api/stream', { websocket: true }, (connection, req) => {
    const token = req.query?.token;
    try {
      app.jwt.verify(token);
    } catch {
      connection.socket.close();
      return;
    }
    realtime.add(connection.socket);
  });
}
