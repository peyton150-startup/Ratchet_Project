import type { PoolClient } from 'pg';
import { ruleSchema, type Rule } from './types';

interface RuleRow {
  rule_key: string;
  version: number;
  trigger: unknown;
  condition: unknown;
  action: unknown;
}

function parseRows(rows: RuleRow[]): Rule[] {
  return rows.map((r) =>
    ruleSchema.parse({
      ruleKey: r.rule_key,
      version: r.version,
      trigger: r.trigger,
      condition: r.condition ?? null,
      action: r.action,
    }),
  );
}

const SELECT_LATEST = `SELECT DISTINCT ON (rule_key) rule_key, version, trigger, condition, action
                         FROM rules
                        WHERE active`;

/** Load the highest active version of each rule for the current tenant (RLS-scoped). */
export async function loadActiveRules(client: PoolClient): Promise<Rule[]> {
  const res = await client.query<RuleRow>(`${SELECT_LATEST} ORDER BY rule_key, version DESC`);
  return parseRows(res.rows);
}

/**
 * Load only the active rules triggered by `eventType`. Filtering in SQL (rather than loading every
 * rule and filtering in JS) keeps the hot ingest path proportional to matching rules, not all rules.
 */
export async function loadRulesForEvent(client: PoolClient, eventType: string): Promise<Rule[]> {
  const res = await client.query<RuleRow>(
    `${SELECT_LATEST} AND trigger->>'type' = 'event' AND trigger->>'event' = $1
      ORDER BY rule_key, version DESC`,
    [eventType],
  );
  return parseRows(res.rows);
}

/** Load only the active schedule-triggered rules (R11 sweeps). */
export async function loadScheduleRules(client: PoolClient): Promise<Rule[]> {
  const res = await client.query<RuleRow>(
    `${SELECT_LATEST} AND trigger->>'type' = 'schedule' ORDER BY rule_key, version DESC`,
  );
  return parseRows(res.rows);
}

export async function insertRule(
  client: PoolClient,
  tenantId: string,
  rule: Rule,
  active = true,
): Promise<void> {
  await client.query(
    `INSERT INTO rules (tenant_id, rule_key, version, trigger, condition, action, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tenantId,
      rule.ruleKey,
      rule.version,
      JSON.stringify(rule.trigger),
      rule.condition === null ? null : JSON.stringify(rule.condition),
      JSON.stringify(rule.action),
      active,
    ],
  );
}

export interface AuditRecord {
  ruleKey: string;
  ruleVersion: number;
  triggerType: 'event' | 'schedule';
  eventId: string | null;
  matched: boolean;
  decision: unknown;
  dryRun: boolean;
}

export async function insertAudit(
  client: PoolClient,
  tenantId: string,
  rec: AuditRecord,
): Promise<void> {
  await insertAuditBatch(client, tenantId, [rec]);
}

/**
 * Insert audit records in a single multi-row statement. A tenant with N rules produces N audit rows
 * per event; batching turns N round-trips into one.
 */
export async function insertAuditBatch(
  client: PoolClient,
  tenantId: string,
  recs: AuditRecord[],
): Promise<void> {
  if (recs.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  for (const rec of recs) {
    const base = params.length;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
    params.push(
      tenantId,
      rec.ruleKey,
      rec.ruleVersion,
      rec.triggerType,
      rec.eventId,
      rec.matched,
      rec.decision === null || rec.decision === undefined ? null : JSON.stringify(rec.decision),
      rec.dryRun,
    );
  }

  await client.query(
    `INSERT INTO rule_audit
       (tenant_id, rule_key, rule_version, trigger_type, event_id, matched, decision, dry_run)
     VALUES ${values.join(', ')}`,
    params,
  );
}
