import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './server.js';
import { MetaClient } from './meta/client.js';
import { startScheduler } from './scheduler.js';

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
    await runMigrations(pool);
  } catch (err) {
    console.error(`database not ready: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  const app = buildServer(config, pool);

  const meta = new MetaClient(config, app.log);
  const stopScheduler = startScheduler({ pool, meta, config, log: app.log });

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    stopScheduler();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
