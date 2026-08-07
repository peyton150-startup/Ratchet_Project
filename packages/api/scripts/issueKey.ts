/**
 * Issue an API key for a tenant (creating the tenant if needed).
 *
 * Keys previously only existed via hand-written SQL, which made onboarding and rotation
 * undocumented tribal knowledge. Only the hash is stored, so the plaintext key is printed once here
 * and can never be recovered — rotate by issuing a new key and deleting the old row.
 *
 *   pnpm --filter @workspace/api issue-key -- --tenant "Acme" --role admin
 *
 * --key sets the plaintext instead of generating one, for a memorable key while testing.
 * Nothing validates key format — auth just hashes the bearer token — so any string works.
 * Only ever use it against a local or throwaway database: a guessable key is a live
 * credential for that tenant's data.
 */
import { Client } from 'pg';
import { hashApiKey } from '../src/auth.js';
import { randomUUID } from 'node:crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const tenantName = arg('tenant');
  const role = arg('role') ?? 'integrator';
  const explicitKey = arg('key');
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!tenantName)
    throw new Error(
      'usage: issue-key --tenant <name> [--role operator|admin|integrator] [--key <plaintext>]',
    );
  if (!['operator', 'admin', 'integrator'].includes(role)) throw new Error(`invalid role: ${role}`);
  if (!connectionString) throw new Error('ADMIN_DATABASE_URL or DATABASE_URL must be set');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const existing = await client.query<{ id: string }>('SELECT id FROM tenants WHERE name = $1', [
      tenantName,
    ]);
    const tenantId =
      existing.rows[0]?.id ??
      (
        await client.query<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [
          tenantName,
        ])
      ).rows[0]!.id;

    const rawKey = explicitKey ?? `rk_${randomUUID().replace(/-/g, '')}`;
    // key_hash is UNIQUE; upsert so re-issuing the same --key re-points it instead of failing.
    await client.query(
      `INSERT INTO api_keys (tenant_id, key_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (key_hash) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, role = EXCLUDED.role`,
      [tenantId, hashApiKey(rawKey), role],
    );

    console.log(`tenant: ${tenantName} (${tenantId})`);
    console.log(`role:   ${role}`);
    console.log(`key:    ${rawKey}`);
    if (explicitKey) {
      console.log('\nThis key was supplied, not generated — keep it to non-production databases.');
    } else {
      console.log('\nStore this key now — only its hash is saved, so it cannot be shown again.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
