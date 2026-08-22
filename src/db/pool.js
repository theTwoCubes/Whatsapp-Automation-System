import pg from 'pg';

export function createPool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
  });
}
