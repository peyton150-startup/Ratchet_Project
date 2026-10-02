// Rule authoring logic for the admin console: condition-tree editing, structural version diffs,
// and validation. Kept pure so the builder's behaviour is testable without a DOM.

// The condition shape, operators, namespaces, state predicates and SLA format all come from the
// shared domain module — the builder and the server validate against one definition.
import {
  COMPARISON_OPS,
  CONDITION_NAMESPACES as NAMESPACES,
  STATE_PREDICATES,
  SLA_PATTERN,
  SLA_HINT,
  EVENT_TYPES,
  SCAN_PREDICATES,
  CANCEL_SCOPES,
  type Condition,
  type ComparisonOp,
} from '@workspace/sdk';

export { COMPARISON_OPS, NAMESPACES, STATE_PREDICATES, EVENT_TYPES, SCAN_PREDICATES, CANCEL_SCOPES };
export type { Condition, ComparisonOp };

export interface RuleDraft {
  ruleKey: string;
  trigger: { type: 'event'; event: string } | { type: 'schedule'; cron: string; scan: string };
  condition: Condition | null;
  action:
    | { kind: 'create_task'; queue: string; sla: string; template: string; priority?: number }
    | { kind: 'cancel_tasks'; scope: string };
}

// ---- validation ------------------------------------------------------------------------------

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

  if (draft.condition !== null) issues.push(...validateCondition(draft.condition));

  if (draft.action.kind === 'create_task') {
    if (!draft.action.queue) issues.push({ field: 'action.queue', message: 'Queue is required' });
    if (!draft.action.template) issues.push({ field: 'action.template', message: 'Template is required' });
    if (!SLA_PATTERN.test(draft.action.sla)) {
      issues.push({ field: 'action.sla', message: SLA_HINT });
    }
    if (draft.action.priority !== undefined && !Number.isInteger(draft.action.priority)) {
      issues.push({ field: 'action.priority', message: 'Priority must be a whole number' });
    }
  }
  return issues;
}

const REF_PATTERN = new RegExp(`^(${NAMESPACES.join('|')})\\.(.+)$`);
const NUMERIC_OPS: readonly string[] = ['gt', 'lt', 'gte', 'lte'];

/**
 * The mistakes the engine would only reveal when an event arrives: a reference outside the four
 * namespaces, a state predicate it does not allowlist, `in` without a list, an ordering comparison
 * against something that is not a number. Each issue's field carries the node's path.
 */
export function validateCondition(c: Condition, path: Path = []): ValidationIssue[] {
  const field = `condition.${path.join('.')}`;
  const kind = kindOf(c);
  if (kind === 'and' || kind === 'or' || kind === 'not') {
    const children = childrenOf(c);
    if (children.length === 0) return [{ field, message: 'A group needs at least one condition' }];
    return children.flatMap((child, i) => validateCondition(child, [...path, i]));
  }
  if ('changed' in c) {
    return c.changed.trim() ? [] : [{ field, message: 'Name the field that must have changed' }];
  }
  if ('state' in c) {
    return (STATE_PREDICATES as readonly string[]).includes(c.state)
      ? []
      : [{ field, message: `Unknown state check: ${c.state || '(empty)'}` }];
  }

  const { op, ref, value } = comparisonParts(c);
  const issues: ValidationIssue[] = [];
  const match = REF_PATTERN.exec(ref);
  if (!match) {
    issues.push({
      field,
      message: `"${ref}" must start with ${NAMESPACES.map((n) => `${n}.`).join(', ')} (for example payload.amount)`,
    });
  } else if (match[1] === 'state' && !(STATE_PREDICATES as readonly string[]).includes(match[2]!)) {
    issues.push({ field, message: `Unknown state value: ${ref}` });
  }
  if (op === 'in' && !Array.isArray(value)) {
    issues.push({ field: `${field}.value`, message: `"in" needs a list, like ["paystub","W2"]` });
  }
  if (NUMERIC_OPS.includes(op) && (value === '' || Number.isNaN(Number(value)) || typeof value === 'boolean' || value === null || Array.isArray(value))) {
    issues.push({ field: `${field}.value`, message: `"${op}" compares numbers; ${literalToText(value) || '(empty)'} is not one` });
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

// ---- editing by path ---------------------------------------------------------------------------
// The editor addresses a node by the child indexes leading to it from the root. A `not` has one
// child, at index 0. Every function returns a new tree.

export type ConditionKind = 'and' | 'or' | 'not' | 'changed' | 'state' | 'comparison';
export type Path = readonly number[];

export function kindOf(c: Condition): ConditionKind {
  if ('and' in c) return 'and';
  if ('or' in c) return 'or';
  if ('not' in c) return 'not';
  if ('changed' in c) return 'changed';
  if ('state' in c) return 'state';
  return 'comparison';
}

export function childrenOf(c: Condition): Condition[] {
  if ('and' in c) return c.and;
  if ('or' in c) return c.or;
  if ('not' in c) return [c.not];
  return [];
}

function withChildren(c: Condition, children: Condition[]): Condition {
  if ('and' in c) return { and: children };
  if ('or' in c) return { or: children };
  if ('not' in c) return { not: children[0]! };
  return c;
}

export function getAt(root: Condition, path: Path): Condition {
  return path.reduce((node, i) => childrenOf(node)[i]!, root);
}

export function replaceAt(root: Condition, path: Path, next: Condition): Condition {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  return withChildren(
    root,
    childrenOf(root).map((child, i) => (i === head ? replaceAt(child, rest, next) : child)),
  );
}

/** Remove the node at `path`. Null when nothing is left; a `not` goes when its child goes. */
export function removeAt(root: Condition, path: Path): Condition | null {
  if (path.length === 0) return null;
  const [head, ...rest] = path;
  const children = childrenOf(root).flatMap((child, i) => {
    if (i !== head) return [child];
    const next = removeAt(child, rest);
    return next === null ? [] : [next];
  });
  if ('not' in root && children.length === 0) return null;
  return withChildren(root, children);
}

/**
 * Add a condition at `path`: appended when the node there is a group, otherwise the node and the
 * new condition become an ALL-of group, so "add another" works on a single condition too.
 */
export function addCondition(root: Condition | null, path: Path, child: Condition): Condition {
  if (root === null) return child;
  const target = getAt(root, path);
  return replaceAt(root, path, isGroup(target) ? addToGroup(target, child) : { and: [target, child] });
}

/** Wrap the node in NOT, or unwrap it if it already is one. */
export function toggleNot(root: Condition, path: Path): Condition {
  const target = getAt(root, path);
  return replaceAt(root, path, 'not' in target ? target.not : { not: target });
}

export function setGroupOp(root: Condition, path: Path, op: 'and' | 'or'): Condition {
  const children = childrenOf(getAt(root, path));
  return replaceAt(root, path, op === 'and' ? { and: children } : { or: children });
}

// ---- comparisons -------------------------------------------------------------------------------

export function comparisonParts(c: Condition): { op: ComparisonOp; ref: string; value: unknown } {
  const [op, operands] = Object.entries(c)[0] as [ComparisonOp, [string, unknown]];
  return { op, ref: operands[0], value: operands[1] };
}

export function makeComparison(op: ComparisonOp, ref: string, value: unknown): Condition {
  return { [op]: [ref, value] } as Condition;
}

/**
 * What a typed value means: JSON where it parses (500000, true, ["paystub","W2"], "620"), otherwise
 * the text itself, so a plain word like paystub needs no quotes.
 */
export function parseLiteral(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The inverse of parseLiteral: text that parses back to exactly this value. */
export function literalToText(value: unknown): string {
  return typeof value === 'string' && parseLiteral(value) === value ? value : JSON.stringify(value);
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

// ---- describing and loading stored rules -------------------------------------------------------

export function describeTrigger(trigger: unknown): string {
  const t = (trigger ?? {}) as { type?: string; event?: string; cron?: string; scan?: string };
  return t.type === 'schedule' ? `on schedule ${t.cron}, for each ${t.scan}` : `when ${t.event}`;
}

export function describeAction(action: unknown): string {
  const a = (action ?? {}) as { kind?: string; template?: string; queue?: string; sla?: string; priority?: number; scope?: string };
  if (a.kind === 'cancel_tasks') return `cancel open tasks for the ${a.scope}`;
  const priority = a.priority ? `, priority ${a.priority}` : '';
  return `create "${a.template}" in ${a.queue}, SLA ${a.sla}${priority}`;
}

/** A stored version as a draft, so an existing rule can be edited instead of retyped. */
export function draftFromVersion(v: { ruleKey: string; trigger: unknown; condition: unknown; action: unknown }): RuleDraft {
  return {
    ruleKey: v.ruleKey,
    trigger: v.trigger as RuleDraft['trigger'],
    condition: (v.condition ?? null) as Condition | null,
    action: v.action as RuleDraft['action'],
  };
}

/** R1, R2 … R10, not R1, R10, R11, R2. */
export function sortRuleKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
