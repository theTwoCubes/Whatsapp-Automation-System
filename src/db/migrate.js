import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Runs any migration files that have not been applied yet, in filename order.
// Each file runs inside its own transaction and is recorded so it only runs
// once.
export async function runMigrations(pool) {
  await pool.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const applied = new Set(
    (await pool.query('select version from schema_migrations')).rows.map((r) => r.version),
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied migration ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

// Allow running standalone: node src/db/migrate.js. Compared as file urls, not
// raw strings, since a path with spaces percent encodes differently between
// import.meta.url and a plain file:// concatenation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadConfig } = await import('../config.js');
  const { createPool } = await import('./pool.js');
  const pool = createPool(loadConfig());
  try {
    await runMigrations(pool);
    console.log('migrations up to date');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
