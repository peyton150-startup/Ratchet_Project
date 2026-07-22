import type { Pool } from 'pg';
import { withTenant } from '../db';
import { evaluateCondition, type EvalContext } from './condition';
import { PgStateProvider, type ScanTarget } from './state';
import { loadActiveRules, insertAudit } from './store';
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
 * Rules engine (Phase 2b). Evaluates events and scheduled sweeps against versioned JSON rules,
 * writing an audit record with the rule version that fired. Dry-run evaluates and returns
 * decisions without persisting audit. Task creation itself is Phase 2c.
 */
export class RulesEngine {
  constructor(private readonly pool: Pool) {}

  async evaluateEvent(
    tenantId: string,
    event: EngineEvent,
    opts: EvaluateOptions = {},
  ): Promise<Decision[]> {
    const dryRun = opts.dryRun ?? false;
    return withTenant(this.pool, tenantId, async (client) => {
      const provider = new PgStateProvider(client);
      const rules = (await loadActiveRules(client)).filter(
        (r) => r.trigger.type === 'event' && r.trigger.event === event.type,
      );

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
      for (const rule of rules) {
        const matched = rule.condition === null ? true : await evaluateCondition(rule.condition, ctx);
        const subject: Record<string, unknown> = { entityId: event.entityId };
        if (applicationId !== undefined) subject['applicationId'] = applicationId;
        const decision = matched ? buildDecision(rule, subject) : null;
        if (!dryRun) {
          await insertAudit(client, tenantId, {
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
      return decisions;
    });
  }

  async runSchedule(
    tenantId: string,
    now: Date,
    opts: EvaluateOptions = {},
  ): Promise<Decision[]> {
    const dryRun = opts.dryRun ?? false;
    return withTenant(this.pool, tenantId, async (client) => {
      const provider = new PgStateProvider(client);
      const rules = (await loadActiveRules(client)).filter((r) => r.trigger.type === 'schedule');

      const decisions: Decision[] = [];
      for (const rule of rules) {
        if (rule.trigger.type !== 'schedule') continue;
        const targets: ScanTarget[] = await provider.scan(rule.trigger.scan, now);
        for (const target of targets) {
          const decision = buildDecision(rule, { ...target });
          if (!dryRun) {
            await insertAudit(client, tenantId, {
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
      return decisions;
    });
  }
}
