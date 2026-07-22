import type { Task } from '@workspace/sdk';

// Task states, legal transitions and terminal states come from the shared domain module, so the
// console cannot offer an action the server would reject — previously this table was a hand-kept
// copy of the API's state machine, guarded only by a test.
export { allowedActions, isTerminalState as isTerminal, type TaskAction } from '@workspace/sdk';

export type SlaStatus = 'none' | 'ok' | 'due-soon' | 'breached';

/** Classify a task's SLA for display. due-soon is within the final hour before the deadline. */
export function slaStatus(slaDueAt: string | null, now: number = Date.now()): SlaStatus {
  if (!slaDueAt) return 'none';
  const due = new Date(slaDueAt).getTime();
  if (Number.isNaN(due)) return 'none';
  if (due <= now) return 'breached';
  if (due - now <= 60 * 60 * 1000) return 'due-soon';
  return 'ok';
}

/** Human-readable time remaining (or overdue) for an SLA deadline. */
export function formatSlaRemaining(slaDueAt: string | null, now: number = Date.now()): string {
  if (!slaDueAt) return '—';
  const due = new Date(slaDueAt).getTime();
  if (Number.isNaN(due)) return '—';
  const diff = due - now;
  const overdue = diff < 0;
  const mins = Math.floor(Math.abs(diff) / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  let text: string;
  if (days > 0) text = `${days}d ${hours % 24}h`;
  else if (hours > 0) text = `${hours}h ${mins % 60}m`;
  else text = `${mins}m`;
  return overdue ? `${text} overdue` : text;
}

/**
 * Merge a live task update into the current list. Subscriptions deliver whole tasks, so an update
 * either replaces an existing row (by id) or prepends a new one. Sorting matches the API's ordering
 * (priority desc, then oldest first) so live rows land where a refetch would put them.
 */
export function applyTaskUpdate(tasks: Task[], updated: Task): Task[] {
  const index = tasks.findIndex((t) => t.id === updated.id);
  const next = index === -1 ? [updated, ...tasks] : tasks.map((t) => (t.id === updated.id ? updated : t));
  return sortTasks(next);
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

export function countByState(tasks: Task[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) out[t.state] = (out[t.state] ?? 0) + 1;
  return out;
}
