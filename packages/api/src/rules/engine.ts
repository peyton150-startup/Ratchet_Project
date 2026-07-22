import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db';
import { evaluateCondition, type EvalContext } from './condition';
import { PgStateProvider, type ScanTarget } from './state';
import { loadRulesForEvent, loadScheduleRules, insertAuditBatch, type AuditRecord } from './store';
import { RulesCache } from './cache';
import type { Action, Rule } from './types';

export interface EngineEvent {
  eventId?: string;
  type: string;
  entityId: string;
  entityType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  delta: Record<string, unknown>;
}

export interface Decision {
  ruleKey: string;
  ruleVersion: number;
  action: Action;
  subject: Record<string, unknown>;
}

export interface EvaluateOptions {
  dryRun?: boolean;
}

function buildDecision(rule: Rule, subject: Record<string, unknown>): Decision {
  return { ruleKey: rule.ruleKey, ruleVersion: rule.version, action: rule.action, subject };
}

/**
 * Rules engine. Evaluates events and scheduled sweeps against versioned JSON rules, writing an
 * audit record with the rule version that fired. Dry-run evaluates and returns decisions without
 * persisting audit — and always reads rules fresh, never from cache.
 *
 * The *WithClient methods let a caller run evaluation inside an existing tenant transaction so a
 * whole pipeline message can be one transaction instead of several.
 */
export class RulesEngine {
  private readonly cache: RulesCache;

  constructor(
    private readonly pool: Pool,
    cache?: RulesCache,
  ) {
    this.cache = cache ?? new RulesCache();
  }

  /** Drop cached rules for a tenant. Call after any rule write. */
  invalidate(tenantId: string): void {
    this.cache.invalidate(tenantId);
  }

  async evaluateEventWithClient(
    client: PoolClient,
    tenantId: string,
    event: EngineEvent,
    opts: EvaluateOptions = {},
  ): Promise<Decision[]> {
    const dryRun = opts.dryRun ?? false;
    const provider = new PgStateProvider(client);
    // Dry-run bypasses the cache: it must see the exact rule versions currently stored.
    const rules = dryRun
      ? await loadRulesForEvent(client, event.type)
      : await this.cache.getForEvent(client, tenantId, event.type);

    const ctx: EvalContext = {
      event: {
        type: event.type,
        entityId: event.entityId,
        entityType: event.entityType,
        occurredAt: event.occurredAt,
      },
      payload: event.payload,
      delta: event.delta,
      state: provider,
    };

    // Carry applicationId on the subject so downstream cancels (R12) can find an application's
    // tasks even when the triggering event's entity is a document/verification/etc.
    const applicationId =
      (event.payload['applicationId'] as string | undefined) ??
      (event.type.startsWith('application.') ? event.entityId : undefined);

    const decisions: Decision[] = [];
    const audits: AuditRecord[] = [];
    for (const rule of rules) {
      const matched = rule.condition === null ? true : await evaluateCondition(rule.condition, ctx);
      const subject: Record<string, unknown> = { entityId: event.entityId };
      if (applicationId !== undefined) subject['applicationId'] = applicationId;
      const decision = matched ? buildDecision(rule, subject) : null;
      if (!dryRun) {
        audits.push({
          ruleKey: rule.ruleKey,
          ruleVersion: rule.version,
          triggerType: 'event',
          eventId: event.eventId ?? null,
          matched,
          decision,
          dryRun: false,
        });
      }
      if (decision) decisions.push(decision);
    }
    await insertAuditBatch(client, tenantId, audits);
    return decisions;
  }

  evaluateEvent(
    tenantId: string,
    event: EngineEvent,
    opts: EvaluateOptions = {},
  ): Promise<Decision[]> {
    return withTenant(this.pool, tenantId, (c) =>
      this.evaluateEventWithClient(c, tenantId, event, opts),
    );
  }

  async runScheduleWithClient(
    client: PoolClient,
    tenantId: string,
    now: Date,
    opts: EvaluateOptions = {},
  ): Promise<Decision[]> {
    const dryRun = opts.dryRun ?? false;
    const provider = new PgStateProvider(client);
    const rules = await loadScheduleRules(client);

    const decisions: Decision[] = [];
    const audits: AuditRecord[] = [];
    for (const rule of rules) {
      if (rule.trigger.type !== 'schedule') continue;
      const targets: ScanTarget[] = await provider.scan(rule.trigger.scan, now);
      for (const target of targets) {
        const decision = buildDecision(rule, { ...target });
        if (!dryRun) {
          audits.push({
            ruleKey: rule.ruleKey,
            ruleVersion: rule.version,
            triggerType: 'schedule',
            eventId: null,
            matched: true,
            decision,
            dryRun: false,
          });
        }
        decisions.push(decision);
      }
    }
    await insertAuditBatch(client, tenantId, audits);
    return decisions;
  }

  runSchedule(tenantId: string, now: Date, opts: EvaluateOptions = {}): Promise<Decision[]> {
    return withTenant(this.pool, tenantId, (c) => this.runScheduleWithClient(c, tenantId, now, opts));
  }
}
