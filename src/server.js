import Fastify from 'fastify';
import { MetaClient } from './meta/client.js';
import { SeenStore } from './dedup.js';
import { verifySignature } from './security.js';
import { processWebhook } from './handlers/message.js';

export function buildServer(config) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
            },
    },
  });

  const meta = new MetaClient(config, app.log);
  const seen = new SeenStore();

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
    req.log.info({ payload: body }, 'webhook payload received');

    setImmediate(() => {
      processWebhook(body, { meta, seen, log: req.log }).catch((err) => {
        req.log.error({ err }, 'unhandled error processing webhook');
      });
    });
  });

  return app;
}
