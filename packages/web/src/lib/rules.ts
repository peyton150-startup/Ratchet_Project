// Rule authoring logic for the admin console: condition-tree editing, structural version diffs,
// and validation. Kept pure so the builder's behaviour is testable without a DOM.

// Mirrors the API's condition union (ADR-004). Comparison variants are spelled out rather than a
// catch-all record so `'and' in c` narrows cleanly.
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

export interface RuleDraft {
  ruleKey: string;
  trigger: { type: 'event'; event: string } | { type: 'schedule'; cron: string; scan: string };
  condition: Condition | null;
  action:
    | { kind: 'create_task'; queue: string; sla: string; template: string; priority?: number }
    | { kind: 'cancel_tasks'; scope: string };
}

export const COMPARISON_OPS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in'] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

export const NAMESPACES = ['event', 'payload', 'delta', 'state'] as const;

/** The state predicates the API allowlists — the builder can only offer these. */
export const STATE_PREDICATES = ['all_required_docs_verified', 'application_stage_rank'] as const;

// ---- validation ------------------------------------------------------------------------------

const SLA_RE = /^\d+[smhd]$/;

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Mirror the API's rule schema so the builder reports problems before a round-trip. */
export function validateDraft(draft: RuleDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!draft.ruleKey.trim()) issues.push({ field: 'ruleKey', message: 'Rule key is required' });

  if (draft.trigger.type === 'event' && !draft.trigger.event) {
    issues.push({ field: 'trigger', message: 'Pick an event type' });
  }
  if (draft.trigger.type === 'schedule') {
    if (!draft.trigger.cron) issues.push({ field: 'trigger', message: 'Cron expression is required' });
    if (!draft.trigger.scan) issues.push({ field: 'trigger', message: 'Scan predicate is required' });
  }

  if (draft.action.kind === 'create_task') {
    if (!draft.action.queue) issues.push({ field: 'action.queue', message: 'Queue is required' });
    if (!draft.action.template) issues.push({ field: 'action.template', message: 'Template is required' });
    if (!SLA_RE.test(draft.action.sla)) {
      issues.push({ field: 'action.sla', message: 'SLA must look like 4h, 30m, 2d or 90s' });
    }
  }
  return issues;
}

// ---- condition tree editing ------------------------------------------------------------------

/** Wrap a condition in a group, or seed an empty group when there is nothing yet. */
export function wrapInGroup(condition: Condition | null, op: 'and' | 'or'): Condition {
  return op === 'and' ? { and: condition ? [condition] : [] } : { or: condition ? [condition] : [] };
}

export function isGroup(c: Condition): c is { and: Condition[] } | { or: Condition[] } {
  return 'and' in c || 'or' in c;
}

function groupKey(c: { and: Condition[] } | { or: Condition[] }): 'and' | 'or' {
  return 'and' in c ? 'and' : 'or';
}

/** Append a child to a group condition, returning a new tree (never mutates). */
export function addToGroup(group: Condition, child: Condition): Condition {
  if (!isGroup(group)) return group;
  const key = groupKey(group);
  const children = (group as Record<string, Condition[]>)[key]!;
  return { [key]: [...children, child] } as Condition;
}

/** Remove the child at `index` from a group, returning a new tree. */
export function removeFromGroup(group: Condition, index: number): Condition {
  if (!isGroup(group)) return group;
  const key = groupKey(group);
  const children = (group as Record<string, Condition[]>)[key]!;
  return { [key]: children.filter((_, i) => i !== index) } as Condition;
}

/** Human-readable one-line summary of a condition — used in the tree view and diffs. */
export function describeCondition(c: Condition | null): string {
  if (c === null) return 'always';
  if ('and' in c) return `(${c.and.map(describeCondition).join(' AND ')})`;
  if ('or' in c) return `(${c.or.map(describeCondition).join(' OR ')})`;
  if ('not' in c) return `NOT ${describeCondition(c.not)}`;
  if ('changed' in c) return `changed(${c.changed})`;
  if ('state' in c) return `state.${c.state}`;
  // Remaining variants are all comparisons: a single key mapping to [ref, literal].
  const entry = Object.entries(c)[0];
  if (!entry) return '(empty)';
  const [op, operands] = entry as [string, [string, unknown]];
  return `${operands[0]} ${op} ${JSON.stringify(operands[1])}`;
}

// ---- version diffing -------------------------------------------------------------------------

export interface FieldDiff {
  field: string;
  before: string;
  after: string;
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface RuleVersionLike {
  version: number;
  trigger: unknown;
  condition: unknown;
  action: unknown;
  active?: boolean;
}

/**
 * Structural diff between two rule versions. Because conditions are structured JSON (ADR-004),
 * differences are meaningful field-level changes rather than text noise — which is exactly why
 * the DSL was chosen to be a tree rather than an expression string.
 */
export function diffVersions(before: RuleVersionLike, after: RuleVersionLike): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  const triggerBefore = render(before.trigger);
  const triggerAfter = render(after.trigger);
  if (triggerBefore !== triggerAfter) {
    diffs.push({ field: 'trigger', before: triggerBefore, after: triggerAfter });
  }

  const condBefore = describeCondition((before.condition ?? null) as Condition | null);
  const condAfter = describeCondition((after.condition ?? null) as Condition | null);
  if (condBefore !== condAfter) {
    diffs.push({ field: 'condition', before: condBefore, after: condAfter });
  }

  const beforeAction = (before.action ?? {}) as Record<string, unknown>;
  const afterAction = (after.action ?? {}) as Record<string, unknown>;
  const actionKeys = new Set([...Object.keys(beforeAction), ...Object.keys(afterAction)]);
  for (const key of [...actionKeys].sort()) {
    const b = render(beforeAction[key]);
    const a = render(afterAction[key]);
    if (b !== a) diffs.push({ field: `action.${key}`, before: b, after: a });
  }

  return diffs;
}
