// Minimal forward-only migration runner. Applies migrations/*.sql in order, once each,
// tracked in schema_migrations. Connects as an admin/superuser role (ADMIN_DATABASE_URL,
// falling back to DATABASE_URL) because migrations create roles and set FORCE RLS.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

async function main(): Promise<void> {
  if (!connectionString) {
    throw new Error('ADMIN_DATABASE_URL or DATABASE_URL must be set to run migrations');
  }
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount && done.rowCount > 0) {
        console.log(`skip   ${file}`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`apply  ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
