// Explicit task state machine. Transitions are the only legal way to change a task's state;
// anything else throws IllegalTransitionError (design doc §12: illegal state transitions).

export type TaskState = 'open' | 'claimed' | 'blocked' | 'completed' | 'cancelled';
export type TaskAction = 'claim' | 'complete' | 'block' | 'unblock' | 'release' | 'cancel';

interface TransitionSpec {
  from: TaskState[];
  to: TaskState;
}

const TRANSITIONS: Record<TaskAction, TransitionSpec> = {
  claim: { from: ['open'], to: 'claimed' },
  complete: { from: ['claimed'], to: 'completed' },
  block: { from: ['claimed'], to: 'blocked' },
  unblock: { from: ['blocked'], to: 'claimed' },
  release: { from: ['claimed'], to: 'open' },
  cancel: { from: ['open', 'claimed', 'blocked'], to: 'cancelled' },
};

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['completed', 'cancelled']);

export class IllegalTransitionError extends Error {
  constructor(
    public readonly current: TaskState,
    public readonly action: TaskAction,
  ) {
    super(`illegal transition: cannot '${action}' a task in state '${current}'`);
    this.name = 'IllegalTransitionError';
  }
}

/** Return the next state for an action, or throw if the action is illegal from `current`. */
export function nextState(current: TaskState, action: TaskAction): TaskState {
  const spec = TRANSITIONS[action];
  if (!spec.from.includes(current)) {
    throw new IllegalTransitionError(current, action);
  }
  return spec.to;
}

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse an SLA duration like '4h', '30m', '2d', '90s' into milliseconds. */
export function parseDuration(sla: string): number {
  const m = DURATION_RE.exec(sla);
  if (!m) throw new Error(`invalid SLA duration: ${sla}`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]!;
}

export function slaDueAt(from: Date, sla: string): Date {
  return new Date(from.getTime() + parseDuration(sla));
}
