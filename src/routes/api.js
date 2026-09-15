import { randomBytes, randomUUID } from 'node:crypto';
import { verifyPassword, hashPassword, DUMMY_PASSWORD_HASH } from '../auth.js';
import { REACTION_EMOJIS } from '../ai/reactions.js';
import { MetaApiError } from '../meta/client.js';
import { handToHuman, handToBot } from '../handoff.js';
import {
  runWeeklyRefinement,
  listProposals,
  dismissProposal,
  markProposalApproved,
} from '../knowledge/refinement.js';
import { getEditableSettings, editableKeys, invalidateSettings, getBranding, getAiSettings, saveAiSettings } from '../settings.js';
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
import { saveSubscription, removeSubscription, getVapidPublicKey, getPushStatus, sendTestPush } from '../push.js';
import {
  getAgentByEmail,
  getAgentAuthState,
  listConversations,
  setConversationFlag,
  muteConversation,
  setConversationBlocked,
  softDeleteConversation,
  clearChat,
  getConversationById,
  findOrCreateComposeConversation,
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
  setAgentRole,
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
  opsStats,
  listContactsForExport,
  queueBulkSend,
  bulkSendBatchProgress,
  listRecentBulkSendBatches,
} from '../db/repo.js';
import ExcelJS from 'exceljs';
import { parseLeadsText } from '../leads/parseLeads.js';
import { getStats as getTelemetryStats } from '../ai/telemetry.js';

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
  // Voice notes and audio files go as WhatsApp audio, not as a document, so
  // they play inline on the lead's phone instead of downloading as a file.
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

// The 24 hour service window is open while the last inbound was under 24 hours
// ago, which we track as window_expires_at.
function windowOpen(conversation) {
  return Boolean(conversation.window_expires_at) && new Date(conversation.window_expires_at) > new Date();
}

// Meta's own errors and the messages this codebase writes itself (e.g.
// "not found", "cannot demote the last admin") are meant to be shown to the
// agent as-is. A raw driver/DB error is not - it can carry constraint or
// column names that are internal implementation detail, not something an
// authenticated-but-non-admin agent should see in their network tab.
const RAW_DB_ERROR_PATTERN = /duplicate key|violates|constraint|column ".*" does not exist|relation ".*" does not exist|syntax error|null value in column/i;
function safeErrorMessage(err, log, context) {
  if (err instanceof MetaApiError) return err.message;
  if (RAW_DB_ERROR_PATTERN.test(err?.message || '')) {
    log?.warn({ err, context }, 'suppressed a raw db error from a client response');
    return 'something went wrong processing that request';
  }
  return err.message;
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
  // Per-agent write throttle so a runaway client (or a stolen token) cannot
  // hammer the DB. Reads are not counted; only mutating requests are.
  const writeLimiter = createRateLimiter({ max: 120, windowMs: 60000 });

  const auth = async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // A demoted or removed agent's existing token is only trustworthy for
    // its role/identity claims if it still matches the current DB state -
    // otherwise a role change or removal would not take effect until the
    // token naturally expires up to 12 hours later.
    const state = await getAgentAuthState(pool, req.user.id);
    if (!state || state.token_version !== req.user.tokenVersion) {
      return reply.code(401).send({ error: 'session no longer valid, please log in again' });
    }
  };

  // Only lets a caller through when the JWT says role=admin. Used to gate
  // Settings, Team, Knowledge, Templates and Audit — anything an ordinary
  // agent should not be able to change.
  const requireAdmin = async (req, reply) => {
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'admin only' });
    }
  };
  // Per-token+IP write rate limit. Attached as a preHandler on write routes.
  const writeLimit = async (req, reply) => {
    const key = `${req.user?.email || 'anon'}@${req.ip}`;
    const gate = writeLimiter(key);
    if (!gate.ok) {
      return reply.code(429).send({ error: 'too many requests, slow down', retryAfter: gate.retryAfter });
    }
  };

  // Every admin mutation goes through here, so this is also where the write
  // rate limit lives now - it used to only cover a handful of routes wired
  // up by hand, leaving most of the admin surface (settings, AI provider
  // keys, FAQs, agents, media upload) with no throttle at all.
  const adminAuth = [auth, requireAdmin, writeLimit];

  // Short-lived tickets for the websocket. Browsers cannot set auth headers on
  // ws:// upgrades, and passing a bearer JWT in the URL means the token ends
  // up in access logs and browser history. We hand out one-use tickets that
  // expire in 30 seconds instead.
  const wsTickets = new Map();
  const issueWsTicket = (email) => {
    const ticket = randomBytes(24).toString('hex');
    wsTickets.set(ticket, { email, expires: Date.now() + 30_000 });
    return ticket;
  };
  const consumeWsTicket = (ticket) => {
    const row = wsTickets.get(ticket);
    if (!row) return null;
    wsTickets.delete(ticket);
    if (Date.now() > row.expires) return null;
    return row;
  };
  // Sweep expired tickets so the map does not grow.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of wsTickets) if (now > v.expires) wsTickets.delete(k);
  }, 60_000).unref?.();

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

  app.post('/api/login', {
    schema: {
      body: {
        type: 'object',
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['email', 'password'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const limit = loginLimiter(req.ip);
    if (!limit.ok) {
      return reply.code(429).send({ error: 'too many attempts, try again shortly', retryAfter: limit.retryAfter });
    }
    const { email, password } = req.body ?? {};
    const agent = email ? await getAgentByEmail(pool, email) : null;
    // Always runs the same scrypt verify whether or not the account exists,
    // so response timing cannot be used to enumerate valid emails.
    const validPassword = verifyPassword(password ?? '', agent?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!agent || !validPassword) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    const role = agent.role === 'admin' ? 'admin' : 'agent';
    const token = app.jwt.sign(
      { id: agent.id, email: agent.email, role, tokenVersion: agent.token_version },
      { expiresIn: '7d' },
    );
    return { token, agent: { id: agent.id, email: agent.email, name: agent.name, role } };
  });

  // Exchange the auth header for a short-lived ticket the websocket can use.
  // The ticket goes on the ws URL, so it stays out of the browser's stored
  // JWT and rotates on every reconnect.
  app.post('/api/ws-ticket', { preHandler: auth }, async (req) => {
    return { ticket: issueWsTicket(req.user.email) };
  });

  app.get('/api/conversations', { preHandler: auth }, async (req) => ({
    conversations: await listConversations(pool, {
      includeArchived: req.query?.archived === '1',
    }),
  }));

  // Downloadable lead list for the client's own CRM/spreadsheet use - name,
  // phone, email and business where we've learned them, filtered to one
  // service or every lead depending on which service tab the export was
  // triggered from.
  app.get('/api/contacts/export', { preHandler: auth }, async (req, reply) => {
    const topicId = req.query?.topicId ? Number(req.query.topicId) : null;
    const contacts = await listContactsForExport(pool, { topicId });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Leads');
    sheet.columns = [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Business', key: 'business', width: 24 },
      { header: 'Service', key: 'service', width: 22 },
      { header: 'Status', key: 'status', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const c of contacts) {
      sheet.addRow({
        name: c.name || '',
        phone: c.wa_id,
        email: c.email || '',
        business: c.business || '',
        service: c.topic_name || '',
        status: c.state,
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(Buffer.from(buffer));
  });

  // Lets an agent start a conversation with a number that hasn't messaged in,
  // from the console's Compose button. Only ever creates the conversation
  // shell - with no window_expires_at set, it opens exactly like any other
  // outside-the-window chat, so the composer already only offers an approved
  // template, same as everywhere else. No separate "template only" flag needed.
  app.post('/api/conversations/compose', {
    preHandler: [auth, writeLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          waId: { type: 'string', minLength: 1, maxLength: 32 },
          name: { type: 'string', maxLength: 120 },
        },
        required: ['waId'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const waId = String(req.body.waId).replace(/\D/g, '');
    if (waId.length < 8 || waId.length > 15) {
      return reply.code(400).send({ error: 'enter a valid phone number with country code, digits only' });
    }
    const name = (req.body?.name ?? '').trim() || null;
    const id = await findOrCreateComposeConversation(pool, { waId, name });
    await audit(req, 'conversation composed', `conversation ${id}`, waId);
    realtime.emit({ type: 'refresh' });
    return { id };
  });

  const MAX_BULK_SEND_ROWS = 2000;

  // Bulk send: the client pastes a list of leads (name, phone, optionally
  // business and email, any order), picks a service and an approved
  // template, and every recipient is queued as its own job for the scheduler
  // to work through - see runBulkSend in scheduler.js for why this is not
  // sent synchronously from this request.
  app.post('/api/bulk-send', {
    preHandler: [auth, writeLimit],
    schema: {
      body: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1 },
          topicId: {},
          templateName: { type: 'string', minLength: 1, maxLength: 512 },
        },
        required: ['text', 'templateName'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { text, templateName } = req.body;
    let topicId = null;
    if (req.body?.topicId != null) {
      topicId = Number(req.body.topicId);
      if (!Number.isInteger(topicId)) return reply.code(400).send({ error: 'topicId must be a whole number' });
      const exists = await pool.query('select 1 from topics where id = $1', [topicId]);
      if (exists.rowCount === 0) return reply.code(400).send({ error: 'that service no longer exists' });
    }

    const approved = await listTemplates(pool);
    if (!approved.some((t) => t.name === templateName)) {
      return reply.code(400).send({ error: 'pick an approved template' });
    }

    const { rows, invalid } = parseLeadsText(text);
    if (rows.length === 0) {
      return reply.code(400).send({ error: 'no valid phone numbers found in the pasted list' });
    }
    if (rows.length > MAX_BULK_SEND_ROWS) {
      return reply.code(400).send({ error: `too many leads in one go - up to ${MAX_BULK_SEND_ROWS} at a time` });
    }

    const batchId = randomUUID();
    const rowsWithTopic = rows.map((r) => ({ ...r, topicId }));
    const queued = await queueBulkSend(pool, batchId, rowsWithTopic, templateName);
    await audit(req, 'bulk send queued', `batch ${batchId}`, `${queued} leads, template ${templateName}`);
    return { batchId, queued, skipped: invalid.length, total: rows.length + invalid.length };
  });

  app.get('/api/bulk-send/batches', { preHandler: auth }, async () => ({
    batches: await listRecentBulkSendBatches(pool),
  }));

  app.get('/api/bulk-send/:batchId', { preHandler: auth }, async (req) => ({
    progress: await bulkSendBatchProgress(pool, req.params.batchId),
  }));

  app.post('/api/conversations/:id/pin', { preHandler: [auth, writeLimit], schema: idParams }, async (req) => {
    const on = req.body?.on !== false;
    await setConversationFlag(pool, req.params.id, 'pin', on);
    await audit(req, on ? 'pin' : 'unpin', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh' });
    return { ok: true };
  });

  app.post('/api/conversations/:id/archive', { preHandler: [auth, writeLimit], schema: idParams }, async (req) => {
    const on = req.body?.on !== false;
    await setConversationFlag(pool, req.params.id, 'archive', on);
    await audit(req, on ? 'archive' : 'unarchive', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh' });
    return { ok: true };
  });

  app.post('/api/conversations/:id/mute', { preHandler: [auth, writeLimit], schema: idParams }, async (req) => {
    // hours: number of hours to mute for; 0 or missing to unmute.
    const hours = Number(req.body?.hours) || 0;
    const until = hours > 0 ? new Date(Date.now() + hours * 3600 * 1000) : null;
    await muteConversation(pool, req.params.id, until);
    await audit(req, until ? `mute ${hours}h` : 'unmute', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh' });
    return { ok: true, until };
  });

  app.post('/api/conversations/:id/block', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
    const on = req.body?.on !== false;
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    // Record our own flag first so the bot goes quiet even if Meta rejects the
    // remote block, then attempt the remote call best-effort.
    await setConversationBlocked(pool, req.params.id, on);
    try {
      if (on) await meta.blockUser(conversation.wa_id);
      else await meta.unblockUser(conversation.wa_id);
    } catch (err) {
      req.log.warn({ err, waId: conversation.wa_id }, 'meta block/unblock failed, local flag kept');
    }
    await audit(req, on ? 'block' : 'unblock', `conversation ${req.params.id}`, conversation.wa_id);
    realtime.emit({ type: 'refresh' });
    return { ok: true };
  });

  app.delete('/api/conversations/:id', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    await softDeleteConversation(pool, req.params.id);
    await cancelDrips(pool, req.params.id);
    await audit(req, 'delete', `conversation ${req.params.id}`, conversation.wa_id);
    realtime.emit({ type: 'refresh' });
    return { ok: true };
  });

  app.post('/api/conversations/:id/clear', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    await clearChat(pool, req.params.id);
    await audit(req, 'clear', `conversation ${req.params.id}`, conversation.wa_id);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  app.get('/api/conversations/:id', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    const { messages, hasMore } = await getConversationMessages(pool, req.params.id, { limit: 50 });

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
      hasMore,
    };
  });

  // Older page for infinite scroll-up. before is the oldest message id the
  // client already holds.
  app.get('/api/conversations/:id/messages', { preHandler: auth, schema: idParams }, async (req) => {
    const before = req.query?.before ? Number(req.query.before) : null;
    const limit = Math.min(Number(req.query?.limit) || 50, 100);
    const { messages, hasMore } = await getConversationMessages(pool, req.params.id, {
      limit,
      beforeId: Number.isInteger(before) ? before : null,
    });
    return { messages, hasMore };
  });

  app.post('/api/conversations/:id/messages', {
    preHandler: [auth, writeLimit],
    schema: {
      ...idParams,
      body: {
        type: 'object',
        properties: {
          // WhatsApp caps text at 4096 chars; anything longer would be rejected
          // downstream anyway.
          body: { type: 'string', minLength: 1, maxLength: 4096 },
          replyTo: { type: ['string', 'null'], maxLength: 128 },
        },
        required: ['body'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
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

    const replyTo = typeof req.body?.replyTo === 'string' ? req.body.replyTo : null;
    try {
      const wamid = await meta.sendText(conversation.wa_id, body, replyTo ? { replyTo } : {});
      if (wamid) {
        await recordOutbound(pool, {
          conversationId: conversation.id,
          waMessageId: wamid,
          body,
          // Store the quoted message id so the thread can render the reply
          // threaded under the original, same as WhatsApp.
          context: replyTo ? { message_id: replyTo } : null,
        });
      }
      await claimConversation(conversation, req.user.email);
      await markAgentReplied(pool, conversation.id);
      await pool.query('update conversations set last_read_at = now() where id = $1', [conversation.id]);
      realtime.emit({ type: 'refresh', conversationId: conversation.id });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // Lets an agent react to a message the same way they would on their phone,
  // limited to a small emoji set. An empty emoji removes a reaction already
  // sent. Not gated behind the AI at all - this is a person, on the console.
  app.post('/api/conversations/:id/reactions', {
    preHandler: [auth, writeLimit],
    schema: {
      ...idParams,
      body: {
        type: 'object',
        properties: {
          wamid: { type: 'string', minLength: 1, maxLength: 128 },
          emoji: { type: 'string', maxLength: 8 },
        },
        required: ['wamid'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const wamid = req.body.wamid;
    const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
    if (emoji && !REACTION_EMOJIS.includes(emoji)) {
      return reply.code(400).send({ error: 'unsupported reaction emoji' });
    }
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    if (!windowOpen(conversation)) {
      return reply.code(409).send({
        error: 'The 24 hour window has closed. You can only send an approved template now.',
        code: 'window_closed',
      });
    }

    try {
      const sentWamid = await meta.sendReaction(conversation.wa_id, wamid, emoji);
      if (sentWamid) {
        await recordOutbound(pool, {
          conversationId: conversation.id,
          waMessageId: sentWamid,
          type: 'reaction',
          reaction: { messageId: wamid, emoji },
        });
      }
      realtime.emit({ type: 'refresh', conversationId: conversation.id });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.post('/api/conversations/:id/template', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'template name is required' });
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });

    try {
      const templateRow = await pool.query('select language from templates where name = $1 limit 1', [name]);
      const language = templateRow.rows[0]?.language || deps.config.dripLanguage;

      const components = bodyComponents(req.body?.params);
      const wamid = await meta.sendTemplate(conversation.wa_id, name, language, components);
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
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.post('/api/conversations/:id/takeover', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
    // If a different agent is already in this chat, refuse unless the caller
    // explicitly says to override. Prevents two agents from silently stomping
    // on each other's replies.
    const current = await getConversationById(pool, req.params.id);
    if (!current) return reply.code(404).send({ error: 'not found' });
    if (current.state === 'human' && current.assignee && current.assignee !== req.user.email && !req.body?.override) {
      return reply.code(409).send({
        error: `${current.assignee} is already in this chat. Pass override to take it anyway.`,
        code: 'already_assigned',
        assignee: current.assignee,
      });
    }
    await handToHuman(pool, req.params.id, req.user.email);
    await cancelDrips(pool, req.params.id);
    await audit(req, current.assignee && current.assignee !== req.user.email ? 'takeover (override)' : 'takeover',
      `conversation ${req.params.id}`, current.assignee || null);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  app.post('/api/conversations/:id/handback', { preHandler: [auth, writeLimit], schema: idParams }, async (req) => {
    await handToBot(pool, req.params.id);
    await audit(req, 'handback', `conversation ${req.params.id}`);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  // Accepting or rejecting a pending handoff. A handoff the bot or a lead
  // queued sits pending until an agent claims it or sends it back to the bot.
  app.post('/api/conversations/:id/accept', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
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

  app.post('/api/conversations/:id/reject', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
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
  app.post('/api/templates/sync', { preHandler: adminAuth }, async (_req, reply) => {
    try {
      const templates = await meta.fetchTemplates();
      await syncTemplates(pool, templates);
      return { synced: templates.length, templates: await listTemplates(pool) };
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // Overview stats.
  app.get('/api/overview', { preHandler: auth }, async () => ({ overview: await overview(pool) }));

  // Where leads actually came from: one row per ad campaign plus an organic
  // bucket for everyone who arrived with no click to whatsapp referral.
  app.get('/api/campaigns', { preHandler: auth }, async () => campaignStats(pool));

  // Links a campaign to a knowledge Topic, so replies for that campaign's
  // leads get boosted toward the right service pack.
  app.put('/api/campaigns/:id', { preHandler: adminAuth, schema: idParams }, async (req, reply) => {
    let topicId = null;
    if (req.body?.topicId) {
      topicId = Number(req.body.topicId);
      if (!Number.isInteger(topicId)) {
        return reply.code(400).send({ error: 'topicId must be a whole number' });
      }
    }
    await linkCampaignTopic(pool, req.params.id, topicId);
    await audit(req, 'campaign topic linked', `campaign ${req.params.id}`);
    return { ok: true };
  });

  // Editable settings.
  app.get('/api/settings', { preHandler: auth }, async () => ({
    settings: await getEditableSettings(pool, deps.config),
  }));

  app.put('/api/settings', { preHandler: adminAuth }, async (req) => {
    const entries = {};
    for (const key of editableKeys) {
      if (req.body && key in req.body) entries[key] = req.body[key];
    }
    await setSettings(pool, entries);
    invalidateSettings();
    await audit(req, 'settings updated', null, Object.keys(entries).join(', '));
    return { settings: await getEditableSettings(pool, deps.config) };
  });

  // AI provider config. Deliberately separate from /api/settings (which any
  // signed-in agent can read) - only an admin can see or change which
  // provider is used or its keys, and keys are never sent back in full.
  app.get('/api/ai-settings', { preHandler: adminAuth }, async () => ({
    aiSettings: await getAiSettings(pool, deps.config),
  }));

  app.put('/api/ai-settings', { preHandler: adminAuth }, async (req, reply) => {
    const provider = req.body?.aiProvider;
    if (provider && provider !== 'openai' && provider !== 'gemini') {
      return reply.code(400).send({ error: 'aiProvider must be openai or gemini' });
    }
    await saveAiSettings(pool, req.body || {});
    const settings = await getSettings(pool, deps.config);
    deps.ai.reconfigure(settings);
    await audit(req, 'ai settings updated', null, provider ? `provider=${provider}` : undefined);
    return { aiSettings: await getAiSettings(pool, deps.config) };
  });

  app.get('/api/audit', { preHandler: adminAuth }, async () => ({ audit: await listAudit(pool, 150) }));

  // Public branding for the console shell, no auth so the login page can theme.
  app.get('/api/branding', async () => ({ branding: await getBranding(pool, deps.config) }));

  // Push notifications: the frontend fetches the public VAPID key, subscribes
  // via the Push API, then hands the subscription back here to be saved.
  app.get('/api/push/vapid-public-key', async () => ({ key: getVapidPublicKey() }));

  app.post('/api/push/subscribe', { preHandler: [auth, writeLimit] }, async (req, reply) => {
    const sub = req.body?.subscription;
    const pushMeta = req.body?.meta || {};
    const email = req.user?.email;
    if (!sub || !email) return reply.code(400).send({ error: 'subscription and login required' });
    try {
      const transport = sub.transport || 'web';
      const tokenPreview = transport === 'fcm'
        ? `fcm:${String(sub.token || '').slice(0, 20)}…`
        : `web:${String(sub.endpoint || '').slice(-20)}`;
      req.log.info({ email, transport, token: tokenPreview }, 'push subscription saved');
      await saveSubscription(pool, email, sub, {
        platform: pushMeta.platform,
        userAgent: req.headers['user-agent'],
      });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.post('/api/push/unsubscribe', { preHandler: [auth, writeLimit] }, async (req) => {
    const endpoint = req.body?.endpoint;
    if (endpoint) await removeSubscription(pool, endpoint);
    return { ok: true };
  });

  // Diagnostic: VAPID status + this agent's subscriptions
  app.get('/api/push/status', { preHandler: auth }, async (req, reply) => {
    try {
      return await getPushStatus(pool, req.user.email);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Test push to the calling agent's devices only
  app.post('/api/push/test', { preHandler: [auth, writeLimit] }, async (req, reply) => {
    try {
      return await sendTestPush(pool, req.user.email, req.log);
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // The in-app notification inbox. The bell in the console reads this.
  app.get('/api/notifications', { preHandler: auth }, async (req) => {
    const rows = (await pool.query(
      `select id, kind, conversation_id, title, body, read_at, saved_at, created_at
       from notifications where agent_email = $1
       order by created_at desc limit 50`,
      [req.user.email],
    )).rows;
    const unread = (await pool.query(
      `select count(*)::int as n from notifications
       where agent_email = $1 and read_at is null`,
      [req.user.email],
    )).rows[0].n;
    return { notifications: rows, unread };
  });

  app.post('/api/notifications/:id/read', { preHandler: [auth, writeLimit], schema: idParams }, async (req) => {
    await pool.query(
      `update notifications set read_at = now()
       where id = $1 and agent_email = $2 and read_at is null`,
      [req.params.id, req.user.email],
    );
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { preHandler: [auth, writeLimit] }, async (req) => {
    await pool.query(
      `update notifications set read_at = now()
       where agent_email = $1 and read_at is null`,
      [req.user.email],
    );
    return { ok: true };
  });

  app.delete('/api/notifications/:id', { preHandler: [auth, writeLimit], schema: idParams }, async (req) => {
    await pool.query(
      'delete from notifications where id = $1 and agent_email = $2',
      [req.params.id, req.user.email],
    );
    return { ok: true };
  });

  app.delete('/api/notifications', { preHandler: [auth, writeLimit] }, async (req) => {
    await pool.query('delete from notifications where agent_email = $1', [req.user.email]);
    return { ok: true };
  });

  app.post('/api/notifications/:id/save', { preHandler: [auth, writeLimit], schema: idParams }, async (req) => {
    await pool.query(
      `update notifications set saved_at = case when saved_at is null then now() else null end
       where id = $1 and agent_email = $2`,
      [req.params.id, req.user.email],
    );
    return { ok: true };
  });

  // Streams media a lead sent, so the console can show it.
  app.get('/api/messages/:id/media', { preHandler: auth, schema: idParams }, async (req, reply) => {
    const message = await getMessageRaw(pool, req.params.id);
    // A lead's inbound file carries a raw webhook payload to pull the media
    // id from; a file the bot sent from the media library never had one -
    // its media id lives on the library asset instead.
    const mediaId = mediaIdFromRaw(message?.raw) || message?.asset_meta_media_id;
    if (!mediaId) return reply.code(404).send({ error: 'no media on this message' });
    try {
      const url = await meta.getMediaUrl(mediaId);
      const { buffer, contentType } = await meta.downloadMedia(url);
      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'private, max-age=300');
      return reply.send(buffer);
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // WhatsApp business profile, straight through to Meta.
  app.get('/api/profile', { preHandler: auth }, async (_req, reply) => {
    try {
      return { profile: await meta.getBusinessProfile() };
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.put('/api/profile', { preHandler: adminAuth }, async (req, reply) => {
    const allowed = ['about', 'address', 'description', 'email', 'vertical', 'websites'];
    const fields = {};
    for (const key of allowed) {
      if (req.body && key in req.body) fields[key] = req.body[key];
    }
    try {
      await meta.updateBusinessProfile(fields);
      return { profile: await meta.getBusinessProfile() };
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
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

  app.post('/api/faqs', { preHandler: adminAuth }, async (req, reply) => {
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
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.put('/api/faqs/:id', { preHandler: adminAuth, schema: idParams }, async (req, reply) => {
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
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.delete('/api/faqs/:id', { preHandler: adminAuth, schema: idParams }, async (req) => {
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
  app.post('/api/faqs/bulk', { preHandler: adminAuth }, async (req, reply) => {
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
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // Dry run: type a message, see the packs assembled, the exact context text
  // the model would see and, if the ai is configured, what it would actually
  // answer. This is the client's confidence check before a change goes live.
  app.post('/api/faqs/simulate', { preHandler: [auth, writeLimit] }, async (req, reply) => {
    const text = (req.body?.text ?? '').toString().trim();
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    const callAi = req.body?.callAi !== false;
    if (!text) return reply.code(400).send({ error: 'a message is required' });
    try {
      const settings = await getSettings(pool, deps.config);
      const result = await simulateReply(pool, deps.ai, deps.config, settings, { text, topicId, callAi });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
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

  app.post('/api/faqs/reorder', { preHandler: adminAuth }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'ids are required' });
    await reorderFaqs(pool, ids);
    await audit(req, 'faqs reordered', null, `${ids.length} entries`);
    return { ok: true };
  });

  app.get('/api/faqs/:id/versions', { preHandler: auth, schema: idParams }, async (req) => ({
    versions: await listFaqVersions(pool, req.params.id),
  }));

  app.post('/api/faqs/versions/:id/rollback', { preHandler: adminAuth, schema: idParams }, async (req, reply) => {
    try {
      const faq = await rollbackFaq(pool, req.params.id, req.user.email);
      await audit(req, 'faq rolled back', `faq ${faq.id}`, `to version ${req.params.id}`);
      return { faq };
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // Knowledge base. Tiered: base is the shared brain, topic is per service.

  // Topics.
  app.get('/api/topics', { preHandler: auth }, async () => ({ topics: await listTopics(pool) }));

  app.post('/api/topics', { preHandler: adminAuth }, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    const slug = (req.body?.slug ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const description = (req.body?.description ?? '').trim() || null;
    const keywords = (req.body?.keywords ?? '').trim() || null;
    const dripSteps = (req.body?.dripSteps ?? '').trim() || null;
    if (!name || !slug) return reply.code(400).send({ error: 'name and slug are required' });
    const topic = await upsertTopic(pool, { slug, name, description, keywords, dripSteps });
    await audit(req, 'topic added', slug);
    return { topic };
  });

  app.put('/api/topics/:id', { preHandler: adminAuth, schema: idParams }, async (req) => {
    const fields = {};
    if (req.body && 'name' in req.body) fields.name = req.body.name;
    if (req.body && 'description' in req.body) fields.description = req.body.description ?? null;
    if (req.body && 'keywords' in req.body) fields.keywords = req.body.keywords ?? null;
    if (req.body && 'active' in req.body) fields.active = req.body.active;
    if (req.body && 'dripSteps' in req.body) fields.dripSteps = req.body.dripSteps ?? null;
    await updateTopic(pool, req.params.id, fields);
    await audit(req, 'topic updated', `topic ${req.params.id}`);
    return { ok: true };
  });

  app.delete('/api/topics/:id', { preHandler: adminAuth, schema: idParams }, async (req) => {
    const result = await deleteTopic(pool, req.params.id);
    await audit(req, 'pack deleted', `topic ${req.params.id}`);
    return { ok: true, movedFaqs: result.movedFaqs };
  });

  // Runs the refinement pass on demand instead of waiting for the weekly
  // schedule. Everything it finds lands as a proposal the client reviews.
  app.post('/api/faqs/refine', { preHandler: adminAuth }, async (req, reply) => {
    try {
      const res = await runWeeklyRefinement(pool, deps.ai);
      await audit(req, 'refinement pass run', null,
        `${res.gaps.proposed} gap(s), ${res.contradictions.proposed} contradiction(s)`);
      return res;
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
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
  app.post('/api/faqs/proposals/:id/approve', { preHandler: adminAuth, schema: idParams }, async (req, reply) => {
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
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.post('/api/faqs/proposals/:id/dismiss', { preHandler: adminAuth, schema: idParams }, async (req) => {
    await dismissProposal(pool, req.params.id, req.user.email);
    await audit(req, 'proposal dismissed', `proposal ${req.params.id}`);
    return { ok: true };
  });

  // Bulk import: paste an FAQ document or raw notes and split it into entries
  // in a pack. A question that already exists gets its answer updated in
  // place rather than skipped, so a download -> edit -> re-paste round trip
  // never creates duplicates.
  app.post('/api/faqs/import', { preHandler: adminAuth }, async (req, reply) => {
    const text = (req.body?.text ?? '').trim();
    const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
    if (!text) return reply.code(400).send({ error: 'text is required' });
    try {
      const res = await ingestText(pool, deps.ai, text, { topicId, actor: req.user.email });
      await audit(req, 'faqs imported', topicId ? `topic ${topicId}` : 'base', `added ${res.added}, updated ${res.updated}, skipped ${res.skipped}`);
      return res;
    } catch (err) {
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // Console agents.
  app.get('/api/agents', { preHandler: auth }, async () => ({ agents: await listAgents(pool) }));

  app.post('/api/agents', { preHandler: adminAuth }, async (req, reply) => {
    const email = (req.body?.email ?? '').trim().toLowerCase();
    const password = req.body?.password ?? '';
    if (!email || password.length < 6) {
      return reply.code(400).send({ error: 'email and a password of at least 6 characters are required' });
    }
    const role = req.body?.role === 'admin' ? 'admin' : 'agent';
    await createAgent(pool, { email, name: req.body?.name ?? null, passwordHash: hashPassword(password), role });
    await audit(req, 'agent added', email, `role=${role}`);
    return { ok: true };
  });

  app.put('/api/agents/:id/role', { preHandler: adminAuth, schema: idParams }, async (req, reply) => {
    const role = req.body?.role;
    if (role !== 'admin' && role !== 'agent') {
      return reply.code(400).send({ error: 'role must be admin or agent' });
    }
    // Look the agent up to know the email (role setter is keyed by email).
    const rows = (await pool.query('select email from agents where id = $1', [req.params.id])).rows;
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    // Guard: never let the last admin be demoted.
    if (role === 'agent') {
      const admins = (await pool.query("select count(*)::int as n from agents where role = 'admin'")).rows[0].n;
      const current = (await pool.query('select role from agents where id = $1', [req.params.id])).rows[0]?.role;
      if (current === 'admin' && admins <= 1) {
        return reply.code(409).send({ error: 'cannot demote the last admin' });
      }
    }
    await setAgentRole(pool, rows[0].email, role);
    await audit(req, 'agent role changed', `agent ${req.params.id}`, `role=${role}`);
    return { ok: true };
  });

  app.delete('/api/agents/:id', { preHandler: adminAuth, schema: idParams }, async (req, reply) => {
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
    const raw = req.query?.topicId;
    const topicId = raw === 'general' ? 'general' : raw ? Number(raw) : null;
    return { media: await listMediaAssets(pool, { topicId }) };
  });

  app.post('/api/media', { preHandler: adminAuth }, async (req, reply) => {
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
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  app.delete('/api/media/:id', { preHandler: adminAuth, schema: idParams }, async (req) => {
    await deleteMediaAsset(pool, req.params.id);
    await audit(req, 'media removed', `asset ${req.params.id}`);
    return { ok: true };
  });

  app.post('/api/conversations/:id/media', { preHandler: [auth, writeLimit], schema: idParams }, async (req, reply) => {
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
      return reply.code(400).send({ error: safeErrorMessage(err, app.log) });
    }
  });

  // Admin ops health panel: DB queue stats + in-process telemetry.
  // Admin-only so operational internals are not exposed to regular agents.
  app.get('/api/admin/ops', { preHandler: adminAuth }, async () => {
    const [db, tele] = await Promise.all([opsStats(pool), Promise.resolve(getTelemetryStats())]);
    return {
      db,
      process: {
        ...tele,
        wsClients: realtime.size(),
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        poolTotal: pool.totalCount,
        poolIdle: pool.idleCount,
        poolWaiting: pool.waitingCount,
      },
    };
  });

  // Live updates. Prefers a short-lived ticket (issued from /api/ws-ticket
  // over an authenticated request), falling back to a JWT for older clients.
  // Tickets are one-use and expire in 30s, so they never leak the way a raw
  // JWT in the URL would.
  app.get('/api/stream', { websocket: true }, (socket, req) => {
    const ticket = req.query?.ticket;
    // Tickets only - a bearer JWT was previously accepted as a fallback here,
    // which reintroduces the exact leak (access logs, browser history) the
    // ticket system exists to avoid. Nothing in this app's own frontend
    // relies on it.
    if (!ticket || !consumeWsTicket(ticket)) { socket.close(); return; }
    realtime.add(socket);
  });
}
