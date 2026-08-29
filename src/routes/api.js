import { verifyPassword, hashPassword } from '../auth.js';
import { handToHuman, handToBot } from '../handoff.js';
import {
  runWeeklyRefinement,
  listProposals,
  dismissProposal,
  markProposalApproved,
} from '../knowledge/refinement.js';
import { getEditableSettings, editableKeys, invalidateSettings, getBranding } from '../settings.js';
import { createRateLimiter } from '../ratelimit.js';
import { listTopics, upsertTopic, updateTopic, deleteTopic } from '../knowledge/topics.js';
import { ingestText } from '../knowledge/ingestion.js';
import {
  listFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
  reorderFaqs,
  listFaqVersions,
  rollbackFaq,
  listPacks,
  searchFaqs,
  bulkUpdateFaqs,
} from '../knowledge/faqs.js';
import { simulateReply } from '../knowledge/simulator.js';
import { getSettings } from '../settings.js';
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
  markInboundRead,
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

  // An agent sending anything to a conversation that is not already theirs
  // has, in effect, just taken it over, whether that was a pending handoff or
  // a chat the bot still owned. Claiming it here means the bot stops replying
  // and any drip follow ups stop firing on top of what the agent just said,
  // the same as clicking Take over would have done.
  const claimConversation = (conversation, email) => {
    if (conversation.state === 'human') return Promise.resolve();
    return Promise.all([handToHuman(pool, conversation.id, email), cancelDrips(pool, conversation.id)]);
  };

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
    
    const readWamid = await markInboundRead(pool, req.params.id);
    if (readWamid) {
      meta.markRead(readWamid).catch(err => req.log.error({ err, wamid: readWamid }, 'failed to mark message read on meta'));
      realtime.emit({ type: 'refresh', conversationId: conversation.id });
    }

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
      await claimConversation(pool, conversation, req.user.email);
      await markAgentReplied(pool, conversation.id);
      await pool.query('update conversations set last_read_at = now() where id = $1', [conversation.id]);
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
      await claimConversation(conversation, req.user.email);
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

  // FAQs. A pack is a topic, plus the base pack every conversation gets.
  // pack=all, pack=base, or pack=<topic id>.
  app.get('/api/packs', { preHandler: auth }, async () => ({ packs: await listPacks(pool) }));

  app.get('/api/faqs', { preHandler: auth }, async (req) => {
    const raw = (req.query?.pack ?? 'all').trim();
    const pack = raw === 'all' || raw === 'base' ? raw : Number(raw);
    if (typeof pack === 'number' && !Number.isInteger(pack)) {
      return { faqs: [] };
    }
    return { faqs: await listFaqs(pool, { pack }) };
  });

  app.post('/api/faqs', { preHandler: auth }, async (req, reply) => {
    try {
      const faq = await createFaq(
        pool,
        {
          topicId: req.body?.topicId ? Number(req.body.topicId) : null,
          question: req.body?.question,
          answer: req.body?.answer,
          verbatim: req.body?.verbatim,
          pinned: req.body?.pinned,
          mediaAssetId: req.body?.mediaAssetId ? Number(req.body.mediaAssetId) : null,
        },
        req.user.email,
      );
      await audit(req, 'faq added', `faq ${faq.id}`, faq.question);
      return { faq };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.put('/api/faqs/:id', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const fields = {};
    for (const key of ['question', 'answer', 'verbatim', 'pinned', 'active']) {
      if (req.body && key in req.body) fields[key] = req.body[key];
    }
    // These two are nullable on purpose, so an explicit null has to be able to
    // clear them rather than being read as "not supplied".
    if (req.body && 'mediaAssetId' in req.body) {
      fields.mediaAssetId = req.body.mediaAssetId ? Number(req.body.mediaAssetId) : null;
    }
    if (req.body && 'topicId' in req.body) {
      fields.topicId = req.body.topicId ? Number(req.body.topicId) : null;
    }

    try {
      const faq = await updateFaq(pool, req.params.id, fields, req.user.email);
      if (!faq) return reply.code(404).send({ error: 'not found' });
      await audit(req, 'faq updated', `faq ${req.params.id}`, Object.keys(fields).join(', '));
      return { faq };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.delete('/api/faqs/:id', { preHandler: auth, schema: idParams }, async (req) => {
    await deleteFaq(pool, req.params.id);
    await audit(req, 'faq deleted', `faq ${req.params.id}`);
    return { ok: true };
  });

  // Substring search across every pack. Kept literal instead of similarity
  // ranked so the client can trust that what is shown is what matched.
  app.get('/api/faqs/search', { preHandler: auth }, async (req) => {
    const q = (req.query?.q ?? '').toString().trim();
    return { faqs: q ? await searchFaqs(pool, q) : [] };
  });

  // Bulk activate, deactivate or delete. Wrapped in a transaction inside so a
  // partial success cannot leave the list mid update.
  app.post('/api/faqs/bulk', { preHandler: auth }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    const action = req.body?.action;
    if (ids.length === 0) return reply.code(400).send({ error: 'ids are required' });
    if (!['activate', 'deactivate', 'delete'].includes(action)) {
      return reply.code(400).send({ error: 'action must be activate, deactivate or delete' });
    }
    try {
      const res = await bulkUpdateFaqs(pool, ids, action, req.user.email);
      await audit(req, `faqs ${action}`, null, `${res.affected} entries`);
      return res;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Dry run: type a message, see the packs assembled, the exact context text
  // the model would see and, if the ai is configured, what it would actually
  // answer. This is the client's confidence check before a change goes live.
  app.post('/api/faqs/simulate', { preHandler: auth }, async (req, reply) => {
    const text = (req.body?.text ?? '').toString().trim();
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    const callAi = req.body?.callAi !== false;
    if (!text) return reply.code(400).send({ error: 'a message is required' });
    try {
      const settings = await getSettings(pool, deps.config);
      const result = await simulateReply(pool, deps.ai, deps.config, settings, { text, topicId, callAi });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Everything in a single JSON dump so the client can back the whole store
  // up, review it offline or diff two states. Ordered exactly as it would go
  // into the prompt: base first, then each service pack in name order, entries
  // in their configured position.
  app.get('/api/faqs/export', { preHandler: auth }, async () => {
    const packs = await listPacks(pool);
    const out = [];
    for (const p of packs) {
      const faqs = await listFaqs(pool, { pack: p.topic_id ?? 'base' });
      out.push({
        pack: p.slug,
        name: p.name,
        topic_id: p.topic_id,
        faqs: faqs.map((f) => ({
          id: f.id,
          question: f.question,
          answer: f.answer,
          verbatim: f.verbatim,
          pinned: f.pinned,
          active: f.active,
          source: f.source,
          media_asset_id: f.media_asset_id,
        })),
      });
    }
    return { exported_at: new Date().toISOString(), packs: out };
  });

  app.post('/api/faqs/reorder', { preHandler: auth }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'ids are required' });
    await reorderFaqs(pool, ids);
    await audit(req, 'faqs reordered', null, `${ids.length} entries`);
    return { ok: true };
  });

  app.get('/api/faqs/:id/versions', { preHandler: auth, schema: idParams }, async (req) => ({
    versions: await listFaqVersions(pool, req.params.id),
  }));

  app.post('/api/faqs/versions/:id/rollback', { preHandler: auth, schema: idParams }, async (req, reply) => {
    try {
      const faq = await rollbackFaq(pool, req.params.id, req.user.email);
      await audit(req, 'faq rolled back', `faq ${faq.id}`, `to version ${req.params.id}`);
      return { faq };
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
    const keywords = (req.body?.keywords ?? '').trim() || null;
    if (!name || !slug) return reply.code(400).send({ error: 'name and slug are required' });
    const topic = await upsertTopic(pool, { slug, name, description, keywords });
    await audit(req, 'topic added', slug);
    return { topic };
  });

  app.put('/api/topics/:id', { preHandler: auth, schema: idParams }, async (req) => {
    const fields = {};
    if (req.body && 'name' in req.body) fields.name = req.body.name;
    if (req.body && 'description' in req.body) fields.description = req.body.description ?? null;
    if (req.body && 'keywords' in req.body) fields.keywords = req.body.keywords ?? null;
    if (req.body && 'active' in req.body) fields.active = req.body.active;
    await updateTopic(pool, req.params.id, fields);
    await audit(req, 'topic updated', `topic ${req.params.id}`);
    return { ok: true };
  });

  app.delete('/api/topics/:id', { preHandler: auth, schema: idParams }, async (req) => {
    const result = await deleteTopic(pool, req.params.id);
    await audit(req, 'pack deleted', `topic ${req.params.id}`);
    return { ok: true, movedFaqs: result.movedFaqs };
  });

  // Runs the refinement pass on demand instead of waiting for the weekly
  // schedule. Everything it finds lands as a proposal the client reviews.
  app.post('/api/faqs/refine', { preHandler: auth }, async (req, reply) => {
    try {
      const res = await runWeeklyRefinement(pool, deps.ai);
      await audit(req, 'refinement pass run', null,
        `${res.gaps.proposed} gap(s), ${res.contradictions.proposed} contradiction(s)`);
      return res;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // What the refinement pass found: proposed answers for gaps the bot ran
  // into, and contradiction pairs it spotted in existing packs. Nothing here
  // is live, everything needs the client to act on it.
  app.get('/api/faqs/proposals', { preHandler: auth }, async (req) => {
    const status = ['open', 'approved', 'dismissed'].includes(req.query?.status) ? req.query.status : 'open';
    return { proposals: await listProposals(pool, { status }) };
  });

  // Approving a gap proposal creates a real FAQ from it. Anything the client
  // edits before hitting approve is what actually gets stored, so the model's
  // draft is a starting point rather than a commitment.
  app.post('/api/faqs/proposals/:id/approve', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const question = (req.body?.question ?? '').trim();
    const answer = (req.body?.answer ?? '').trim();
    const topicId = req.body?.topicId !== undefined
      ? (req.body.topicId ? Number(req.body.topicId) : null)
      : undefined;

    if (!question || !answer) {
      return reply.code(400).send({ error: 'question and answer are required' });
    }
    try {
      const proposal = await pool.query('select topic_id, kind from faq_proposals where id = $1', [req.params.id]);
      if (proposal.rows.length === 0) return reply.code(404).send({ error: 'not found' });
      if (proposal.rows[0].kind !== 'gap') {
        return reply.code(400).send({ error: 'only gap proposals turn into new answers, contradictions are just dismissed once resolved' });
      }
      const finalTopicId = topicId === undefined ? proposal.rows[0].topic_id : topicId;
      const faq = await createFaq(
        pool,
        { question, answer, topicId: finalTopicId, source: 'refinement' },
        req.user.email,
      );
      await markProposalApproved(pool, req.params.id, req.user.email);
      await audit(req, 'gap proposal approved', `faq ${faq.id}`, question);
      return { faq };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/faqs/proposals/:id/dismiss', { preHandler: auth, schema: idParams }, async (req) => {
    await dismissProposal(pool, req.params.id, req.user.email);
    await audit(req, 'proposal dismissed', `proposal ${req.params.id}`);
    return { ok: true };
  });

  // Bulk import: paste an FAQ document or raw notes and split it into entries
  // in a pack. Duplicates are skipped by comparing the question text.
  app.post('/api/faqs/import', { preHandler: auth }, async (req, reply) => {
    const text = (req.body?.text ?? '').trim();
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    if (!text) return reply.code(400).send({ error: 'text is required' });
    try {
      const res = await ingestText(pool, deps.ai, text, { topicId, actor: req.user.email });
      await audit(req, 'faqs imported', topicId ? `topic ${topicId}` : 'base', `added ${res.added}, skipped ${res.skipped}`);
      return res;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
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
      const id = await addMediaAsset(pool, {
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
      await claimConversation(conversation, req.user.email);
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
  app.get('/api/stream', { websocket: true }, (socket, req) => {
    const token = req.query?.token;
    try {
      app.jwt.verify(token);
    } catch {
      socket.close();
      return;
    }
    realtime.add(socket);
  });
}
