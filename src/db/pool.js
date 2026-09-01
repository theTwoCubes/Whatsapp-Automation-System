import pg from 'pg';

export function createPool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    // 2 vCPU comfortably handles this; more headroom for concurrent webhooks
    // and console requests without starving on connections.
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // A stuck query can no longer pin a connection forever: Postgres aborts a
    // statement past 8s and any transaction left idle past 10s. Named so it is
    // easy to spot in pg_stat_activity.
    application_name: 'wa-console',
    statement_timeout: 8000,
    idle_in_transaction_session_timeout: 10000,
  });
}
