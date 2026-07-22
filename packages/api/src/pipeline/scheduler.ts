import type { Pool } from 'pg';
import { RulesEngine } from '../rules/engine';
import { TaskProcessor } from '../tasks/processor';
import type { RoutingService } from '../routing/assign';

export interface SchedulerDeps {
  admin: Pool; // used only to discover tenants with schedule rules (cross-tenant)
  engine: RulesEngine;
  processor: TaskProcessor;
  routing?: RoutingService;
}

/** Tenants that have at least one active scheduled rule (admin/bypass-RLS discovery). */
export async function tenantsWithScheduleRules(admin: Pool): Promise<string[]> {
  const r = await admin.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM rules WHERE active AND trigger->>'type' = 'schedule'`,
  );
  return r.rows.map((x) => x.tenant_id);
}

/**
 * Runs time-triggered rules (R11). For each tenant with schedule rules it evaluates the sweeps and
 * turns each decision into a task via the processor (exactly-once per (rule, subject), so repeated
 * sweeps do not duplicate). Optionally auto-assigns. This is the missing driver that makes scheduled
 * rules actually fire in the running system.
 */
export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  async runForTenant(tenantId: string, now: Date): Promise<number> {
    const decisions = await this.deps.engine.runSchedule(tenantId, now);
    for (const decision of decisions) {
      const outcome = await this.deps.processor.processDecision(tenantId, null, decision);
      if (
        this.deps.routing &&
        outcome.status === 'ok' &&
        outcome.result?.kind === 'created' &&
        outcome.result.task.created
      ) {
        await this.deps.routing.assign(tenantId, outcome.result.task.taskId).catch(() => {});
      }
    }
    return decisions.length;
  }

  async runAll(now: Date): Promise<number> {
    const tenants = await tenantsWithScheduleRules(this.deps.admin);
    let total = 0;
    for (const tenantId of tenants) {
      total += await this.runForTenant(tenantId, now);
    }
    return total;
  }
}
