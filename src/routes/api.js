import { verifyPassword } from '../auth.js';
import { handToHuman, handToBot } from '../handoff.js';
import {
  getAgentByEmail,
  listConversations,
  getConversationById,
  getConversationMessages,
  listTemplates,
  recordOutbound,
  cancelDrips,
} from '../db/repo.js';

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
    return { conversation, messages };
  });

  app.post('/api/conversations/:id/messages', { preHandler: auth }, async (req, reply) => {
    const body = (req.body?.body ?? '').trim();
    if (!body) return reply.code(400).send({ error: 'body is required' });
    const conversation = await getConversationById(pool, req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });

    try {
      const wamid = await meta.sendText(conversation.wa_id, body);
      if (wamid) await recordOutbound(pool, { conversationId: conversation.id, waMessageId: wamid, body });
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
      const wamid = await meta.sendTemplate(conversation.wa_id, name, deps.config.dripLanguage);
      if (wamid) {
        await recordOutbound(pool, {
          conversationId: conversation.id,
          waMessageId: wamid,
          type: 'template',
          body: `[template] ${name}`,
        });
      }
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
