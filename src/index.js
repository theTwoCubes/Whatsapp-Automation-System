import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './server.js';
import { MetaClient } from './meta/client.js';
import { AiClient } from './ai/client.js';
import { createRealtime } from './realtime.js';
import { startScheduler } from './scheduler.js';
import { pushConfigured } from './push.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The database container can take a moment to accept connections after a
// restart, so retry a few times before giving up.
async function migrateWithRetry(pool, attempts = 10, delayMs = 2000) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await runMigrations(pool);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.error(`database not ready (attempt ${i}/${attempts}), retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const pool = createPool(config);
  try {
    await migrateWithRetry(pool);
  } catch (err) {
    console.error(`database not ready after retries: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  const realtime = createRealtime();
  const app = buildServer(config, pool, realtime);

  if (process.env.NODE_ENV === 'production' && config.jwtSecret === 'dev-only-change-me') {
    app.log.warn('JWT_SECRET is not set, using the insecure default. Set JWT_SECRET in production.');
  }

  // Push notification sanity checks — noisy so a stale deploy is obvious.
  if (!pushConfigured()) {
    app.log.warn('VAPID keys are not set. Web push will silently no-op. Run: node scripts/generate-vapid.js >> .env');
  }
  try {
    const fcmRows = Number(
      (await pool.query("select count(*) as n from push_subscriptions where transport = 'fcm'")).rows[0].n,
    );
    if (fcmRows > 0 && !process.env.FCM_SERVICE_ACCOUNT_JSON) {
      app.log.warn({ fcmRows }, 'FCM_SERVICE_ACCOUNT_JSON is not set but FCM subscriptions exist. APK pushes will not be delivered.');
    }
  } catch { /* table may not exist on the very first migrate — ignore */ }

  const meta = new MetaClient(config, app.log);
  const ai = new AiClient(config, app.log);
  const stopScheduler = startScheduler({ pool, meta, ai, config, realtime, log: app.log });

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    stopScheduler();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A bug slipping past every try/catch should not take the process down
  // silently. Log it with the same structured logger as everything else,
  // then shut down cleanly rather than leaving the process in a broken state.
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    app.log.error({ err }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
