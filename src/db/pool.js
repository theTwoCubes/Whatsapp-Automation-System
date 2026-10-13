import pg from 'pg';

export function createPool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    // 2 vCPU comfortably handles this; more headroom for concurrent webhooks
    // and console requests without starving on connections.
    max: 20,
    // Longer than the scheduler's 60s tick on purpose. At 30s the pool was
    // always empty by the time the scheduler woke on an otherwise idle system,
    // so every single tick paid for a fresh tcp connect and auth - about 1440
    // a day, and two of them lost the handshake over a 48h window, each one
    // failing that tick with "Connection terminated due to connection
    // timeout". Keeping one connection warm removes the churn and the failure
    // window with it.
    idleTimeoutMillis: 90000,
    connectionTimeoutMillis: 5000,
    // A stuck query can no longer pin a connection forever: Postgres aborts a
    // statement past 8s and any transaction left idle past 10s. Named so it is
    // easy to spot in pg_stat_activity.
    application_name: 'wa-console',
    statement_timeout: 8000,
    idle_in_transaction_session_timeout: 10000,
  });
}
