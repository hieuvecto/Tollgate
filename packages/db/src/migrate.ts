import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const directory = join(here, '..', 'migrations');
const db = pool();
await db.query(
  'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
);
for (const name of (await readdir(directory)).filter((item) => item.endsWith('.sql')).sort()) {
  const exists = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
  if (exists.rowCount) continue;
  const sql = await readFile(join(directory, name), 'utf8');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
await db.end();
