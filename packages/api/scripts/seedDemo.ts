/**
 * Seed the loan-pipeline demo from docs/demo-domain.md: the 5 queues, agents, and the 12 rules
 * (R1-R12). docs/demo-domain.md says "the seed script is just this file turned into inserts" — this
 * is that script. Idempotent: re-running replaces the tenant's demo rules/queues rather than
 * duplicating them.
 *
 *   pnpm --filter @workspace/api seed -- --tenant "Acme"
 */
import { Client } from 'pg';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const QUEUES: Array<{ name: string; strategy: string; requiredSkill?: string }> = [
  { name: 'intake', strategy: 'round_robin' },
  { name: 'verification', strategy: 'skill_tag', requiredSkill: 'verification' },
  { name: 'underwriting', strategy: 'capacity' },
  { name: 'processing', strategy: 'round_robin' },
  { name: 'closing', strategy: 'round_robin' },
];

const AGENTS: Array<{ name: string; skills: string[]; capacity: number; queues: string[] }> = [
  { name: 'Ava Intake', skills: [], capacity: 8, queues: ['intake', 'processing'] },
  { name: 'Ben Verifier', skills: ['verification'], capacity: 6, queues: ['verification'] },
  { name: 'Cara Underwriter', skills: ['underwriting'], capacity: 4, queues: ['underwriting'] },
  { name: 'Dan Closer', skills: [], capacity: 5, queues: ['closing', 'processing'] },
];

interface SeedRule {
  ruleKey: string;
  trigger: unknown;
  condition: unknown;
  action: unknown;
}

// The 12 rules from docs/demo-domain.md.
const RULES: SeedRule[] = [
  {
    ruleKey: 'R1',
    trigger: { type: 'event', event: 'application.submitted' },
    condition: null,
    action: { kind: 'create_task', queue: 'intake', sla: '4h', template: 'Initial completeness check' },
  },
  {
    ruleKey: 'R2',
    trigger: { type: 'event', event: 'application.submitted' },
    condition: { gt: ['payload.amount', 500000] },
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Senior review', priority: 5 },
  },
  {
    ruleKey: 'R3',
    trigger: { type: 'event', event: 'document.uploaded' },
    condition: { in: ['payload.type', ['paystub', 'W2']] },
    action: { kind: 'create_task', queue: 'verification', sla: '24h', template: 'Verify income' },
  },
  {
    ruleKey: 'R4',
    trigger: { type: 'event', event: 'document.uploaded' },
    condition: { eq: ['payload.type', 'bank_statement'] },
    action: { kind: 'create_task', queue: 'verification', sla: '24h', template: 'Verify assets' },
  },
  {
    ruleKey: 'R5',
    trigger: { type: 'event', event: 'verification.completed' },
    condition: { eq: ['payload.outcome', 'fail'] },
    action: { kind: 'create_task', queue: 'intake', sla: '8h', template: 'Request replacement document' },
  },
  {
    ruleKey: 'R6',
    trigger: { type: 'event', event: 'borrower.updated' },
    condition: { lt: ['payload.credit_score', 620] },
    action: { kind: 'create_task', queue: 'underwriting', sla: '48h', template: 'Manual credit review' },
  },
  {
    ruleKey: 'R7',
    trigger: { type: 'event', event: 'verification.completed' },
    condition: { state: 'all_required_docs_verified' },
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Run underwriting' },
  },
  {
    ruleKey: 'R8',
    trigger: { type: 'event', event: 'condition.created' },
    condition: null,
    action: { kind: 'create_task', queue: 'processing', sla: '72h', template: 'Collect condition item' },
  },
  {
    ruleKey: 'R9',
    trigger: { type: 'event', event: 'condition.cleared' },
    condition: { eq: ['payload.openConditions', 0] },
    action: { kind: 'create_task', queue: 'closing', sla: '24h', template: 'Clear to close' },
  },
  {
    ruleKey: 'R10',
    trigger: { type: 'event', event: 'application.updated' },
    condition: { and: [{ changed: 'amount' }, { gt: ['state.application_stage_rank', 3] }] },
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Re-underwrite' },
  },
  {
    ruleKey: 'R11',
    trigger: { type: 'schedule', cron: '0 2 * * *', scan: 'stale_documents_at_underwriting' },
    condition: null,
    action: { kind: 'create_task', queue: 'intake', sla: '24h', template: 'Request updated document' },
  },
  {
    ruleKey: 'R12',
    trigger: { type: 'event', event: 'application.withdrawn' },
    condition: null,
    action: { kind: 'cancel_tasks', scope: 'application' },
  },
];

async function main(): Promise<void> {
  const tenantName = arg('tenant') ?? 'Demo';
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('ADMIN_DATABASE_URL or DATABASE_URL must be set');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{ id: string }>('SELECT id FROM tenants WHERE name = $1', [tenantName]);
    const tenantId =
      existing.rows[0]?.id ??
      (await client.query<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [tenantName]))
        .rows[0]!.id;

    // Idempotent: clear this tenant's demo config before re-seeding.
    await client.query('DELETE FROM queue_members WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM agents WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM queues WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM rules WHERE tenant_id = $1', [tenantId]);

    for (const q of QUEUES) {
      await client.query(
        'INSERT INTO queues (tenant_id, name, strategy, required_skill) VALUES ($1, $2, $3, $4)',
        [tenantId, q.name, q.strategy, q.requiredSkill ?? null],
      );
    }

    for (const a of AGENTS) {
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO agents (tenant_id, name, skills, capacity) VALUES ($1, $2, $3, $4) RETURNING id',
        [tenantId, a.name, a.skills, a.capacity],
      );
      for (const queue of a.queues) {
        await client.query(
          'INSERT INTO queue_members (tenant_id, queue, agent_id) VALUES ($1, $2, $3)',
          [tenantId, queue, inserted.rows[0]!.id],
        );
      }
    }

    for (const r of RULES) {
      await client.query(
        `INSERT INTO rules (tenant_id, rule_key, version, trigger, condition, action, active)
         VALUES ($1, $2, 1, $3, $4, $5, true)`,
        [
          tenantId,
          r.ruleKey,
          JSON.stringify(r.trigger),
          r.condition === null ? null : JSON.stringify(r.condition),
          JSON.stringify(r.action),
        ],
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded tenant "${tenantName}" (${tenantId})`);
    console.log(`  queues: ${QUEUES.length}  agents: ${AGENTS.length}  rules: ${RULES.length}`);
    console.log('\nIssue a key with:  pnpm --filter @workspace/api issue-key -- --tenant "' + tenantName + '" --role admin');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
