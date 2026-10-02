import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskAction } from '@workspace/sdk';
import type { AuditEntry, ConnectionStatus, ConsoleApi, EventSummary } from '../lib/api';
import { auditOutcome, auditTrigger } from '../lib/audit';
import {
  STATE_FILTERS,
  allowedActions,
  applyTaskUpdate,
  assigneeLabel,
  countByState,
  formatSlaRemaining,
  matchesStateFilter,
  rowActions,
  slaStatus,
  sortTasks,
  type StateFilter,
} from '../lib/tasks';
import { Badge, Button, Card, EmptyState, PageShell, Toolbar, tokens, type BadgeTone } from '../components';

const SLA_TONE: Record<string, BadgeTone> = {
  none: 'neutral',
  ok: 'ok',
  'due-soon': 'warn',
  breached: 'danger',
};

const STATE_TONE: Record<string, BadgeTone> = {
  open: 'accent',
  claimed: 'warn',
  blocked: 'danger',
  completed: 'ok',
  cancelled: 'neutral',
};

const ACTION_TONE: Record<TaskAction, BadgeTone> = {
  claim: 'accent',
  complete: 'ok',
  block: 'danger',
  unblock: 'accent',
  release: 'neutral',
  cancel: 'danger',
};

const CONNECTION_TONE: Record<ConnectionStatus, BadgeTone> = {
  connecting: 'neutral',
  live: 'ok',
  reconnecting: 'warn',
  offline: 'danger',
};

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  offline: 'offline',
};

// Capitalised so a filter chip never reads the same as a state badge in the table.
const filterLabel = (f: StateFilter): string => f.charAt(0).toUpperCase() + f.slice(1);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function OperatorConsole({ api }: { api: ConsoleApi }) {
  const [queues, setQueues] = useState<string[]>([]);
  const [queue, setQueue] = useState<string | undefined>(undefined);
  const [stateFilter, setStateFilter] = useState<StateFilter>('active');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');

  // Read through a ref by the live-update handlers, so changing the filter does not tear down and
  // reopen the subscription.
  const stateFilterRef = useRef(stateFilter);
  stateFilterRef.current = stateFilter;
  const keep = useCallback((t: Task) => matchesStateFilter(t, stateFilterRef.current), []);

  useEffect(() => {
    api.queues().then((qs) => setQueues(qs.map((q) => q.name))).catch((e) => setError(errorText(e)));
  }, [api]);

  useEffect(() => api.onConnectionStatus(setConnection), [api]);

  useEffect(() => {
    let cancelled = false;
    api
      .tasks(stateFilter === 'active' ? { queue, activeOnly: true } : { queue, state: stateFilter })
      .then((t) => {
        if (!cancelled) setTasks(sortTasks(t));
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [api, queue, stateFilter]);

  // Live updates: merge each pushed task into the list (replace, insert, or drop it when it no longer
  // matches the state filter), keeping API ordering.
  useEffect(() => {
    const unsubscribe = api.subscribeToQueue(
      queue,
      (task) => {
        setTasks((current) => applyTaskUpdate(current, task, keep));
        setSelected((current) => (current && current.id === task.id ? task : current));
      },
      setError,
    );
    return unsubscribe;
  }, [api, queue, keep]);

  const act = useCallback(
    async (task: Task, action: TaskAction) => {
      try {
        const updated = await api.act(action, task.id);
        setError(null);
        setTasks((current) => applyTaskUpdate(current, updated, keep));
        setSelected((current) => (current && current.id === updated.id ? updated : current));
      } catch (e) {
        setError(errorText(e));
      }
    },
    [api, keep],
  );

  const counts = useMemo(() => countByState(tasks), [tasks]);

  const sidebar = (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Queues</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(2) }}>
        <Button tone={queue === undefined ? 'accent' : 'neutral'} onClick={() => setQueue(undefined)}>
          All queues
        </Button>
        {queues.map((q) => (
          <Button key={q} tone={queue === q ? 'accent' : 'neutral'} onClick={() => setQueue(q)}>
            {q}
          </Button>
        ))}
      </div>
    </Card>
  );

  return (
    <PageShell title="Ratchet — Operator Console" sidebar={sidebar}>
      <Toolbar>
        <Badge tone={CONNECTION_TONE[connection]}>{CONNECTION_LABEL[connection]}</Badge>
        {Object.entries(counts).map(([state, n]) => (
          <Badge key={state} tone={STATE_TONE[state] ?? 'neutral'}>
            {state}: {n}
          </Badge>
        ))}
      </Toolbar>

      <div style={{ marginTop: tokens.space(3) }}>
        <Toolbar>
          <span style={{ color: tokens.color.textMuted, fontSize: '13px' }}>Show</span>
          {STATE_FILTERS.map((f) => (
            <Button key={f} tone={stateFilter === f ? 'accent' : 'neutral'} onClick={() => setStateFilter(f)}>
              {filterLabel(f)}
            </Button>
          ))}
        </Toolbar>
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space(3),
            color: tokens.color.danger,
            marginTop: tokens.space(3),
          }}
        >
          <span>{error}</span>
          <Button onClick={() => setError(null)}>dismiss</Button>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: tokens.space(4), marginTop: tokens.space(4) }}>
        {/* Scrolls sideways within itself: on a narrow window the table is wider than its share of
            the row, and would otherwise run underneath the detail panel. */}
        <div style={{ flex: 2, minWidth: 0, overflowX: 'auto' }}>
          <Card style={{ minWidth: 'min-content' }}>
            {tasks.length === 0 ? (
              <EmptyState>
                {stateFilter === 'active' ? 'No tasks in this queue.' : `No ${stateFilter} tasks in this queue.`}
              </EmptyState>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ color: tokens.color.textMuted, textAlign: 'left' }}>
                    <th style={{ padding: tokens.space(2) }}>Task</th>
                    <th style={{ padding: tokens.space(2) }}>Queue</th>
                    <th style={{ padding: tokens.space(2) }}>Assignee</th>
                    <th style={{ padding: tokens.space(2) }}>State</th>
                    <th style={{ padding: tokens.space(2) }}>SLA</th>
                    <th style={{ padding: tokens.space(2) }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => setSelected(t)}
                      style={{ borderTop: `1px solid ${tokens.color.border}`, cursor: 'pointer' }}
                    >
                      <td style={{ padding: tokens.space(2) }}>{t.template}</td>
                      <td style={{ padding: tokens.space(2) }}>{t.queue}</td>
                      <td
                        style={{
                          padding: tokens.space(2),
                          color: t.assignee ? tokens.color.text : tokens.color.textMuted,
                        }}
                      >
                        {assigneeLabel(t)}
                      </td>
                      <td style={{ padding: tokens.space(2) }}>
                        <Badge tone={STATE_TONE[t.state] ?? 'neutral'}>{t.state}</Badge>
                      </td>
                      <td style={{ padding: tokens.space(2) }}>
                        <Badge tone={SLA_TONE[slaStatus(t.slaDueAt)] ?? 'neutral'}>
                          {formatSlaRemaining(t.slaDueAt)}
                        </Badge>
                      </td>
                      <td style={{ padding: tokens.space(2) }}>
                        <Toolbar>
                          {rowActions(t.state).map((a) => (
                            <Button key={a} onClick={() => act(t, a)} tone={ACTION_TONE[a]}>
                              {a}
                            </Button>
                          ))}
                        </Toolbar>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <TaskDetail api={api} task={selected} onCancel={() => act(selected, 'cancel')} />
          ) : (
            <Card>
              <EmptyState>Select a task.</EmptyState>
            </Card>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function TaskDetail({ api, task, onCancel }: { api: ConsoleApi; task: Task; onCancel: () => void }) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const entityId = (task.subject['entityId'] as string | undefined) ?? '';

  useEffect(() => {
    if (!entityId) return;
    api.events(entityId).then(setEvents).catch(() => setEvents([]));
  }, [api, entityId]);

  // Every rule that looked at the event behind this task. Empty for a task from a scheduled sweep,
  // and when the request fails: the heading below still says which rule created the task.
  const [evaluations, setEvaluations] = useState<AuditEntry[]>([]);
  useEffect(() => {
    let stale = false;
    setEvaluations([]);
    api
      .ruleAudit({ taskId: task.id })
      .then((rows) => {
        if (!stale) setEvaluations(rows);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [api, task.id]);

  // A half-confirmed cancel must not carry over to another task, or survive a state change.
  useEffect(() => setConfirmingCancel(false), [task.id, task.state]);

  const canCancel = allowedActions(task.state).includes('cancel');

  return (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>{task.template}</div>
      <div style={{ color: tokens.color.textMuted, fontSize: '13px', marginBottom: tokens.space(3) }}>
        {task.ruleKey} v{task.ruleVersion} · {task.queue} · priority {task.priority}
      </div>
      <div style={{ fontSize: '13px', marginBottom: tokens.space(3) }}>
        <span style={{ color: tokens.color.textMuted }}>Assigned to </span>
        {assigneeLabel(task)}
      </div>
      <Toolbar>
        <Badge tone={STATE_TONE[task.state] ?? 'neutral'}>{task.state}</Badge>
        <Badge tone={SLA_TONE[slaStatus(task.slaDueAt)] ?? 'neutral'}>
          {formatSlaRemaining(task.slaDueAt)}
        </Badge>
      </Toolbar>

      {canCancel ? (
        <div style={{ marginTop: tokens.space(3), fontSize: '13px' }}>
          {confirmingCancel ? (
            // Wraps: the detail panel is narrow, and the question plus two buttons do not fit one line.
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space(2), alignItems: 'center' }}>
              <span>Cancel this task? It cannot be reopened.</span>
              <Button tone="danger" onClick={onCancel}>
                yes, cancel it
              </Button>
              <Button onClick={() => setConfirmingCancel(false)}>keep it</Button>
            </div>
          ) : (
            <Button tone="danger" onClick={() => setConfirmingCancel(true)}>
              cancel task
            </Button>
          )}
        </div>
      ) : null}

      <div style={{ fontWeight: 600, margin: `${tokens.space(4)} 0 ${tokens.space(2)}` }}>Why this task exists</div>
      <div style={{ fontSize: '13px' }}>
        Created by {task.ruleKey} v{task.ruleVersion}
        {evaluations[0] ? ` from ${auditTrigger(evaluations[0])}` : ''}.
      </div>
      {evaluations.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: `${tokens.space(2)} 0 0`, fontSize: '13px' }}>
          {evaluations.map((e) => (
            <li
              key={e.id}
              style={{
                padding: `${tokens.space(1)} 0`,
                color: e.matched ? tokens.color.text : tokens.color.textMuted,
              }}
            >
              <strong>
                {e.ruleKey} v{e.ruleVersion}
              </strong>{' '}
              {auditOutcome(e)}
            </li>
          ))}
        </ul>
      ) : null}

      <div style={{ fontWeight: 600, margin: `${tokens.space(4)} 0 ${tokens.space(2)}` }}>Event history</div>
      {events.length === 0 ? (
        <EmptyState>No events for this entity.</EmptyState>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px' }}>
          {events.map((e) => (
            <li key={e.id} style={{ borderTop: `1px solid ${tokens.color.border}`, padding: tokens.space(2) }}>
              <EventRow event={e} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const hasKeys = (o: Record<string, unknown> | null | undefined): boolean => !!o && Object.keys(o).length > 0;

function EventRow({ event }: { event: EventSummary }) {
  // Inline, so it sits beside the disclosure marker instead of wrapping under it.
  const heading = (
    <>
      {event.type}
      <span style={{ color: tokens.color.textMuted }}> · {new Date(event.occurredAt).toLocaleString()}</span>
    </>
  );
  // Nothing to expand: render it flat rather than as a disclosure that opens onto nothing.
  if (!hasKeys(event.payload) && !hasKeys(event.delta)) return <div>{heading}</div>;

  const preStyle = {
    margin: `${tokens.space(2)} 0 0`,
    fontSize: '12px',
    color: tokens.color.textMuted,
    overflowX: 'auto',
  } as const;

  return (
    <details>
      <summary style={{ cursor: 'pointer' }}>{heading}</summary>
      {hasKeys(event.payload) ? <pre style={preStyle}>payload {JSON.stringify(event.payload, null, 2)}</pre> : null}
      {hasKeys(event.delta) ? <pre style={preStyle}>delta {JSON.stringify(event.delta, null, 2)}</pre> : null}
    </details>
  );
}
