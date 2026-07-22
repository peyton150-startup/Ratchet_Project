import {
  TERMINAL_TASK_STATES,
  parseSlaMs,
  transitionTarget,
  type TaskAction,
  type TaskState,
} from '@workspace/sdk';

// The transition table, task states and SLA format live in the shared domain module so the API,
// the consoles and integrators cannot drift apart. This file adds only the server-side concern the
// shared module deliberately has no opinion on: how an illegal transition is reported.

export type { TaskAction, TaskState };
export { parseSlaMs };

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(TERMINAL_TASK_STATES);

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
  const target = transitionTarget(current, action);
  if (target === null) throw new IllegalTransitionError(current, action);
  return target;
}

/** Parse an SLA duration like '4h' into milliseconds. */
export function parseDuration(sla: string): number {
  return parseSlaMs(sla);
}

export function slaDueAt(from: Date, sla: string): Date {
  return new Date(from.getTime() + parseSlaMs(sla));
}
