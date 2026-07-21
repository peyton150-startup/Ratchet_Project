import type { PoolClient } from 'pg';
import { ruleSchema, type Rule } from './types';

interface RuleRow {
  rule_key: string;
  version: number;
  trigger: unknown;
  condition: unknown;
  action: unknown;
}

/** Load the highest active version of each rule for the current tenant (RLS-scoped). */
export async function loadActiveRules(client: PoolClient): Promise<Rule[]> {
  const res = await client.query<RuleRow>(
    `SELECT DISTINCT ON (rule_key) rule_key, version, trigger, condition, action
       FROM rules
      WHERE active
      ORDER BY rule_key, version DESC`,
  );
  return res.rows.map((r) =>
    ruleSchema.parse({
      ruleKey: r.rule_key,
      version: r.version,
      trigger: r.trigger,
      condition: r.condition ?? null,
      action: r.action,
    }),
  );
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
  await client.query(
    `INSERT INTO rule_audit
       (tenant_id, rule_key, rule_version, trigger_type, event_id, matched, decision, dry_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      rec.ruleKey,
      rec.ruleVersion,
      rec.triggerType,
      rec.eventId,
      rec.matched,
      rec.decision === null || rec.decision === undefined ? null : JSON.stringify(rec.decision),
      rec.dryRun,
    ],
  );
}
