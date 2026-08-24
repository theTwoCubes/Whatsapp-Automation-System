import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { MetaClient } from './meta/client.js';
import { AiClient } from './ai/client.js';
import { verifySignature } from './security.js';
import { processWebhook } from './handlers/message.js';
import { registerApi } from './routes/api.js';
import { createRealtime } from './realtime.js';
import { seedAdmin } from './auth.js';
import { metrics } from './db/repo.js';

const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

export function buildServer(config, pool, realtime = createRealtime()) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
        remove: true,
      },
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
            },
    },
  });

  // Basic security headers on every response.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  const meta = new MetaClient(config, app.log);
  const ai = new AiClient(config, app.log);

  app.register(fastifyJwt, { secret: config.jwtSecret });
  app.register(fastifyWebsocket);
  app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // Keep the raw JSON bytes so signature verification can hash the body as it
  // was received, then parse alongside it.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body;
    try {
      const json = body.length ? JSON.parse(body.toString('utf8')) : {};
      done(null, json);
    } catch (err) {
      done(err, undefined);
    }
  });

  app.get('/health', () => ({ status: 'ok' }));

  // Readiness: only ok once the database is reachable. For orchestration.
  app.get('/ready', async (_req, reply) => {
    try {
      await pool.query('select 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not ready' });
    }
  });

  // Prometheus style metrics. Restrict this at the proxy if you do not want the
  // counts public.
  app.get('/metrics', async (_req, reply) => {
    const m = await metrics(pool);
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return (
      [
        `wa_leads ${m.leads}`,
        `wa_conversations_bot ${m.bot_chats}`,
        `wa_conversations_human ${m.human_chats}`,
        `wa_messages_inbound ${m.inbound}`,
        `wa_messages_outbound ${m.outbound}`,
        `wa_drip_pending ${m.drip_pending}`,
      ].join('\n') + '\n'
    );
  });

  // Meta verification handshake. Echoes hub.challenge when the mode is subscribe
  // and the token matches, otherwise 403.
  app.get('/webhook', (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.verifyToken) {
      req.log.info('webhook verification succeeded');
      return reply.code(200).type('text/plain').send(challenge);
    }

    req.log.warn({ mode }, 'webhook verification failed');
    return reply.code(403).send('Forbidden');
  });

  // Inbound receiver. Checks the signature, acknowledges with 200 before any
  // processing, then routes messages and statuses out of band.
  app.post('/webhook', (req, reply) => {
    const raw = req.rawBody ?? Buffer.alloc(0);
    const signature = req.headers['x-hub-signature-256'];
    const sigHeader = Array.isArray(signature) ? signature[0] : signature;

    if (!verifySignature(raw, sigHeader, config.appSecret)) {
      req.log.warn('invalid webhook signature, rejecting');
      reply.code(401).send({ error: 'invalid signature' });
      return;
    }

    reply.code(200).send();

    const body = req.body;
    // The payload carries message text and phone numbers, so keep the full dump
    // to debug level and only log a summary at info in production.
    if (process.env.NODE_ENV === 'production') {
      req.log.info({ entries: body?.entry?.length ?? 0 }, 'webhook received');
      req.log.debug({ payload: body }, 'webhook payload');
    } else {
      req.log.info({ payload: body }, 'webhook payload received');
    }

    setImmediate(() => {
      processWebhook(body, { meta, ai, pool, config, realtime, log: req.log }).catch((err) => {
        req.log.error({ err }, 'unhandled error processing webhook');
      });
    });
  });

  // Register the api inside a plugin so its routes load after the websocket
  // plugin. Adding a websocket route synchronously before the plugin finishes
  // loading means its onRoute hook never sees the route and the upgrade fails.
  app.register(async (instance) => {
    registerApi(instance, { pool, meta, config, realtime });
  });

  // Serve the built console if it is there. Missing in dev and test, which is fine.
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === 'GET' && !req.raw.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  app.addHook('onReady', async () => {
    await seedAdmin(pool, config, app.log);
  });

  return app;
}
