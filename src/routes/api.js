import { verifyPassword, hashPassword } from '../auth.js';
import { handToHuman, handToBot } from '../handoff.js';
import { getEditableSettings, editableKeys, invalidateSettings, getBranding } from '../settings.js';
import { createRateLimiter } from '../ratelimit.js';
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
  listKnowledge,
  addKnowledge,
  updateKnowledge,
  deleteKnowledge,
  listAgents,
  createAgent,
  deleteAgent,
  overview,
  addMediaAsset,
  listMediaAssets,
  getMediaAsset,
  addAudit,
  listAudit,
  getMessageRaw,
} from '../db/repo.js';

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

  // Knowledge base.
  app.get('/api/knowledge', { preHandler: auth }, async () => ({ knowledge: await listKnowledge(pool) }));

  app.post('/api/knowledge', { preHandler: auth }, async (req, reply) => {
    const title = (req.body?.title ?? '').trim();
    const content = (req.body?.content ?? '').trim();
    if (!title || !content) return reply.code(400).send({ error: 'title and content are required' });
    const id = await addKnowledge(pool, { title, content });
    return { id };
  });

  app.put('/api/knowledge/:id', { preHandler: auth, schema: idParams }, async (req) => {
    await updateKnowledge(pool, req.params.id, {
      title: req.body?.title,
      content: req.body?.content,
      active: req.body?.active,
    });
    return { ok: true };
  });

  app.delete('/api/knowledge/:id', { preHandler: auth, schema: idParams }, async (req) => {
    await deleteKnowledge(pool, req.params.id);
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

  // Media library.
  app.get('/api/media', { preHandler: auth }, async () => ({ media: await listMediaAssets(pool) }));

  app.post('/api/media', { preHandler: auth }, async (req, reply) => {
    let file;
    try {
      file = await req.file();
    } catch {
      file = null;
    }
    if (!file) return reply.code(400).send({ error: 'a file is required' });

    try {
      const buffer = await file.toBuffer();
      const kind = mediaKind(file.mimetype);
      const metaMediaId = await meta.uploadMedia(buffer, file.mimetype, file.filename);
      const id = await addMediaAsset(pool, {
        metaMediaId,
        filename: file.filename,
        mimeType: file.mimetype,
        kind,
      });
      return { id, kind, filename: file.filename };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
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
        });
      }
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
