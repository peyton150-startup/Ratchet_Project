import type { Condition } from './types';

export interface EventContext {
  type: string;
  entityId: string;
  entityType: string;
  occurredAt: string;
}

export interface EvalContext {
  event: EventContext;
  payload: Record<string, unknown>;
  delta: Record<string, unknown>;
  state: StateProvider;
}

/** Resolves allowlisted state.* predicates against current state (R7 and stage lookups). */
export interface StateProvider {
  resolve(name: string, ctx: EvalContext): Promise<unknown>;
}

async function resolveRef(ref: string, ctx: EvalContext): Promise<unknown> {
  const dot = ref.indexOf('.');
  if (dot === -1) throw new Error(`invalid ref (missing namespace): ${ref}`);
  const ns = ref.slice(0, dot);
  const path = ref.slice(dot + 1);
  switch (ns) {
    case 'event':
      return (ctx.event as unknown as Record<string, unknown>)[path];
    case 'payload':
      return ctx.payload[path];
    case 'delta':
      return ctx.delta[path];
    case 'state':
      return ctx.state.resolve(path, ctx);
    default:
      throw new Error(`unknown ref namespace: ${ns}`);
  }
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return NaN;
}

/** Evaluate a structured condition tree to a boolean. Async because state.* may query the DB. */
export async function evaluateCondition(node: Condition, ctx: EvalContext): Promise<boolean> {
  if ('and' in node) {
    const results = await Promise.all(node.and.map((c) => evaluateCondition(c, ctx)));
    return results.every(Boolean);
  }
  if ('or' in node) {
    const results = await Promise.all(node.or.map((c) => evaluateCondition(c, ctx)));
    return results.some(Boolean);
  }
  if ('not' in node) {
    return !(await evaluateCondition(node.not, ctx));
  }
  if ('changed' in node) {
    return Object.prototype.hasOwnProperty.call(ctx.delta, node.changed);
  }
  if ('state' in node) {
    return Boolean(await ctx.state.resolve(node.state, ctx));
  }

  // Comparison operators: [ref, literal].
  if ('eq' in node) {
    return (await resolveRef(node.eq[0], ctx)) === node.eq[1];
  }
  if ('neq' in node) {
    return (await resolveRef(node.neq[0], ctx)) !== node.neq[1];
  }
  if ('gt' in node) {
    return asNumber(await resolveRef(node.gt[0], ctx)) > asNumber(node.gt[1]);
  }
  if ('lt' in node) {
    return asNumber(await resolveRef(node.lt[0], ctx)) < asNumber(node.lt[1]);
  }
  if ('gte' in node) {
    return asNumber(await resolveRef(node.gte[0], ctx)) >= asNumber(node.gte[1]);
  }
  if ('lte' in node) {
    return asNumber(await resolveRef(node.lte[0], ctx)) <= asNumber(node.lte[1]);
  }
  // 'in'
  const left = await resolveRef(node.in[0], ctx);
  const right = node.in[1];
  return Array.isArray(right) && right.includes(left);
}
