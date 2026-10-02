// Test-event authoring logic for the console: a working sample per event type, JSON field parsing,
// and which rules an event type would wake. Kept pure so it is testable without a DOM.

import { EVENT_ENTITY, EVENT_TYPES, type Condition, type EventType } from '@workspace/sdk';
import { describeCondition } from './rules';

export { EVENT_TYPES };
export type { EventType };

export interface EventSample {
  entityId: string;
  payload: Record<string, unknown>;
  delta: Record<string, unknown>;
}

// The demo's running example is application app-1001, so a document, a condition and a verification
// sent one after another all attach to the same file.
const APPLICATION = 'app-1001';

const ENTITY_ID: Record<string, string> = {
  LoanApplication: APPLICATION,
  Document: 'doc-1001',
  VerificationResult: 'ver-1001',
  UnderwritingDecision: 'uw-1001',
  Condition: 'cond-1001',
  Borrower: 'bor-1001',
};

/**
 * One payload per event type that makes at least one seeded rule fire where a rule exists for it
 * (docs/demo-domain.md). Keyed by EventType so adding an event type fails the build until it has one.
 */
const PAYLOADS: Record<EventType, { payload: Record<string, unknown>; delta?: Record<string, unknown> }> = {
  'application.submitted': { payload: { amount: 750000 } },
  'application.updated': { payload: { amount: 800000 }, delta: { amount: 800000 } },
  'application.withdrawn': { payload: {} },
  'document.uploaded': { payload: { type: 'paystub', applicationId: APPLICATION } },
  'document.rejected': { payload: { applicationId: APPLICATION, reason: 'illegible' } },
  'verification.completed': { payload: { outcome: 'fail', applicationId: APPLICATION, documentId: 'doc-1001' } },
  'underwriting.decision_recorded': { payload: { outcome: 'conditions', applicationId: APPLICATION } },
  'condition.created': { payload: { applicationId: APPLICATION, description: 'Proof of insurance' } },
  'condition.cleared': { payload: { applicationId: APPLICATION, openConditions: 0 } },
  'borrower.updated': { payload: { credit_score: 590 } },
  'closing.scheduled': { payload: { closingDate: '2026-11-15' } },
};

export function sampleFor(type: EventType): EventSample {
  const { payload, delta } = PAYLOADS[type];
  return { entityId: ENTITY_ID[EVENT_ENTITY[type]] ?? 'entity-1001', payload, delta: delta ?? {} };
}

export type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/** Parse a form field that must hold a JSON object. Blank means an empty object. */
export function parseJsonObject(text: string): JsonObjectResult {
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'must be a JSON object, like {"amount": 750000}' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface ListeningRule {
  ruleKey: string;
  condition: string;
  outcome: string;
}

interface RuleLike {
  ruleKey: string;
  trigger: unknown;
  condition: unknown;
  action: unknown;
  active: boolean;
}

/** The active rules an event of `type` wakes, with what each needs and what it does. */
export function rulesListeningTo(type: string, rules: RuleLike[]): ListeningRule[] {
  return rules
    .filter((r) => {
      const trigger = r.trigger as { type?: string; event?: string } | null;
      return r.active && trigger?.type === 'event' && trigger.event === type;
    })
    .map((r) => {
      const action = (r.action ?? {}) as { kind?: string; template?: string; queue?: string; scope?: string };
      return {
        ruleKey: r.ruleKey,
        condition: describeCondition((r.condition ?? null) as Condition | null),
        outcome:
          action.kind === 'create_task'
            ? `creates "${action.template}" in ${action.queue}`
            : `cancels open tasks for the ${action.scope}`,
      };
    })
    .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey, undefined, { numeric: true }));
}
