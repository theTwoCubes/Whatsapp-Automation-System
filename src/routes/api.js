import { verifyPassword } from '../auth.js';
import { handToHuman, handToBot } from '../handoff.js';
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
} from '../db/repo.js';

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

  const auth = async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.post('/api/login', async (req, reply) => {
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

  app.get('/api/conversations/:id', { preHandler: auth }, async (req, reply) => {
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

  app.post('/api/conversations/:id/messages', { preHandler: auth }, async (req, reply) => {
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

  app.post('/api/conversations/:id/template', { preHandler: auth }, async (req, reply) => {
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
      realtime.emit({ type: 'refresh', conversationId: conversation.id });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/conversations/:id/takeover', { preHandler: auth }, async (req) => {
    await handToHuman(pool, req.params.id, req.user.email);
    await cancelDrips(pool, req.params.id);
    realtime.emit({ type: 'refresh', conversationId: req.params.id });
    return { ok: true };
  });

  app.post('/api/conversations/:id/handback', { preHandler: auth }, async (req) => {
    await handToBot(pool, req.params.id);
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
