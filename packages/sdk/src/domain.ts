/**
 * Shared domain vocabulary — the single source of truth for rules the API, the consoles, and
 * integrators must all agree on.
 *
 * Why this module exists: task states, legal transitions, the event catalog and the SLA format were
 * each defined in two-to-four places. Adding a state or an event type meant editing every copy, and
 * missing one made the console silently disagree with the server. That is information leakage: the
 * same design decision encoded in multiple modules.
 *
 * This is deliberately pure and dependency-free (no node built-ins, no pg, no React) so every
 * package can depend on it and the SDK's browser entry stays browser-safe.
 */

// ---- task state machine ------------------------------------------------------------------------

export const TASK_STATES = ['open', 'claimed', 'blocked', 'completed', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_ACTIONS = ['claim', 'complete', 'block', 'unblock', 'release', 'cancel'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** The transition table. Every legal state change in the system is expressed here, once. */
export const TRANSITIONS: Readonly<Record<TaskAction, { from: readonly TaskState[]; to: TaskState }>> = {
  claim: { from: ['open'], to: 'claimed' },
  complete: { from: ['claimed'], to: 'completed' },
  block: { from: ['claimed'], to: 'blocked' },
  unblock: { from: ['blocked'], to: 'claimed' },
  release: { from: ['claimed'], to: 'open' },
  cancel: { from: ['open', 'claimed', 'blocked'], to: 'cancelled' },
};

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'cancelled'];

/** States a task can still be worked from — used for queue views, assignment and cancellation. */
export const ACTIVE_TASK_STATES: readonly TaskState[] = TASK_STATES.filter(
  (s) => !TERMINAL_TASK_STATES.includes(s),
);

export function isTerminalState(state: string): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/** Actions legal from `state`. The console uses this so it never offers a rejected action. */
export function allowedActions(state: string): TaskAction[] {
  return TASK_ACTIONS.filter((action) =>
    (TRANSITIONS[action].from as readonly string[]).includes(state),
  );
}

/** The state an action leads to, or null when the action is illegal from `state`. */
export function transitionTarget(state: string, action: TaskAction): TaskState | null {
  const spec = TRANSITIONS[action];
  return (spec.from as readonly string[]).includes(state) ? spec.to : null;
}

// ---- SLA durations -----------------------------------------------------------------------------

/** e.g. 4h, 30m, 2d, 90s. One definition, used for validation *and* parsing. */
export const SLA_PATTERN = /^(\d+)([smhd])$/;
export const SLA_HINT = 'SLA must be a number followed by s, m, h, or d (e.g. 4h)';

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function isValidSla(sla: string): boolean {
  return SLA_PATTERN.test(sla);
}

/** Parse an SLA duration into milliseconds. Throws on a malformed value. */
export function parseSlaMs(sla: string): number {
  const m = SLA_PATTERN.exec(sla);
  if (!m) throw new Error(`invalid SLA duration: ${sla}`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

// ---- event catalog -----------------------------------------------------------------------------

/** The demo domain's events, mapped to the entity each one concerns (docs/demo-domain.md). */
export const EVENT_ENTITY = {
  'application.submitted': 'LoanApplication',
  'application.updated': 'LoanApplication',
  'application.withdrawn': 'LoanApplication',
  'document.uploaded': 'Document',
  'document.rejected': 'Document',
  'verification.completed': 'VerificationResult',
  'underwriting.decision_recorded': 'UnderwritingDecision',
  'condition.created': 'Condition',
  'condition.cleared': 'Condition',
  'borrower.updated': 'Borrower',
  'closing.scheduled': 'LoanApplication',
} as const;

export type EventType = keyof typeof EVENT_ENTITY;

export const EVENT_TYPES = Object.keys(EVENT_ENTITY) as [EventType, ...EventType[]];

export function entityTypeFor(type: EventType): string {
  return EVENT_ENTITY[type];
}

// ---- rules DSL ---------------------------------------------------------------------------------

export const COMPARISON_OPS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in'] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

/** Namespaces a condition reference may address (ADR-004). */
export const CONDITION_NAMESPACES = ['event', 'payload', 'delta', 'state'] as const;

/** State predicates the engine allowlists — the rule builder can only offer these. */
export const STATE_PREDICATES = ['all_required_docs_verified', 'application_stage_rank'] as const;

/** The structured condition tree (ADR-004). Comparisons are spelled out so `'and' in c` narrows. */
export type Condition =
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }
  | { changed: string }
  | { state: string }
  | { eq: [string, unknown] }
  | { neq: [string, unknown] }
  | { gt: [string, unknown] }
  | { lt: [string, unknown] }
  | { gte: [string, unknown] }
  | { lte: [string, unknown] }
  | { in: [string, unknown] };

export const QUEUE_STRATEGIES = ['round_robin', 'skill_tag', 'capacity'] as const;
export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];
