import type { Pool } from 'pg';
import { withTenant } from '../db';

export interface RuleVersionView {
  ruleKey: string;
  version: number;
  trigger: unknown;
  condition: unknown;
  action: unknown;
  active: boolean;
  createdAt: Date;
}

interface RuleVersionRow {
  rule_key: string;
  version: number;
  trigger: unknown;
  condition: unknown;
  action: unknown;
  active: boolean;
  created_at: Date;
}

function toView(r: RuleVersionRow): RuleVersionView {
  return {
    ruleKey: r.rule_key,
    version: r.version,
    trigger: r.trigger,
    condition: r.condition,
    action: r.action,
    active: r.active,
    createdAt: r.created_at,
  };
}

/**
 * Every stored rule version for the tenant, newest first — the admin console lists these and diffs
 * adjacent versions. Unlike the engine's loaders this returns inactive and superseded versions too,
 * because version history is the point.
 */
export async function listRuleVersions(
  pool: Pool,
  tenantId: string,
  ruleKey?: string,
): Promise<RuleVersionView[]> {
  return withTenant(pool, tenantId, async (c) => {
    const r = ruleKey
      ? await c.query<RuleVersionRow>(
          `SELECT rule_key, version, trigger, condition, action, active, created_at
             FROM rules WHERE rule_key = $1 ORDER BY rule_key, version DESC`,
          [ruleKey],
        )
      : await c.query<RuleVersionRow>(
          `SELECT rule_key, version, trigger, condition, action, active, created_at
             FROM rules ORDER BY rule_key, version DESC`,
        );
    return r.rows.map(toView);
  });
}

export interface NewRuleVersion {
  ruleKey: string;
  trigger: unknown;
  condition: unknown;
  action: unknown;
  active?: boolean;
}

/**
 * Publish the next version of a rule. The version number is derived inside the transaction
 * (max + 1 for that rule key), and publishing an active version deactivates the previous ones so
 * exactly one version of a rule key is live.
 */
export async function createRuleVersion(
  pool: Pool,
  tenantId: string,
  input: NewRuleVersion,
): Promise<RuleVersionView> {
  return withTenant(pool, tenantId, async (c) => {
    const next = await c.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM rules WHERE rule_key = $1`,
      [input.ruleKey],
    );
    const version = next.rows[0]!.version;
    const active = input.active ?? true;

    if (active) {
      await c.query(`UPDATE rules SET active = false WHERE rule_key = $1`, [input.ruleKey]);
    }

    const r = await c.query<RuleVersionRow>(
      `INSERT INTO rules (tenant_id, rule_key, version, trigger, condition, action, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING rule_key, version, trigger, condition, action, active, created_at`,
      [
        tenantId,
        input.ruleKey,
        version,
        JSON.stringify(input.trigger),
        input.condition === null || input.condition === undefined
          ? null
          : JSON.stringify(input.condition),
        JSON.stringify(input.action),
        active,
      ],
    );
    return toView(r.rows[0]!);
  });
}
