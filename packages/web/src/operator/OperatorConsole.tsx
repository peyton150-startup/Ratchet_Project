import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Task } from '@workspace/sdk';
import { ConsoleApi } from '../lib/api';
import {
  allowedActions,
  applyTaskUpdate,
  countByState,
  formatSlaRemaining,
  slaStatus,
  sortTasks,
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

export function OperatorConsole({ api }: { api: ConsoleApi }) {
  const [queues, setQueues] = useState<string[]>([]);
  const [queue, setQueue] = useState<string | undefined>(undefined);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    api.queues().then((qs) => setQueues(qs.map((q) => q.name))).catch((e) => setError(String(e)));
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api
      .tasks({ queue })
      .then((t) => {
        if (!cancelled) setTasks(sortTasks(t));
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [api, queue]);

  // Live updates: merge each pushed task into the list (replace or insert), keeping API ordering.
  useEffect(() => {
    const unsubscribe = api.subscribeToQueue(queue, (task) => {
      setLive(true);
      setTasks((current) => applyTaskUpdate(current, task));
      setSelected((current) => (current && current.id === task.id ? task : current));
    });
    return unsubscribe;
  }, [api, queue]);

  const act = useCallback(
    async (task: Task, action: 'claim' | 'complete' | 'block') => {
      try {
        const updated = await api.act(action, task.id);
        setTasks((current) => applyTaskUpdate(current, updated));
        setSelected((current) => (current && current.id === updated.id ? updated : current));
      } catch (e) {
        setError(String(e));
      }
    },
    [api],
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
        <Badge tone={live ? 'ok' : 'neutral'}>{live ? 'live' : 'connecting…'}</Badge>
        {Object.entries(counts).map(([state, n]) => (
          <Badge key={state} tone={STATE_TONE[state] ?? 'neutral'}>
            {state}: {n}
          </Badge>
        ))}
      </Toolbar>

      {error ? (
        <div style={{ color: tokens.color.danger, marginTop: tokens.space(3) }}>{error}</div>
      ) : null}

      <div style={{ display: 'flex', gap: tokens.space(4), marginTop: tokens.space(4) }}>
        <div style={{ flex: 2, minWidth: 0 }}>
          <Card>
            {tasks.length === 0 ? (
              <EmptyState>No tasks in this queue.</EmptyState>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ color: tokens.color.textMuted, textAlign: 'left' }}>
                    <th style={{ padding: tokens.space(2) }}>Task</th>
                    <th style={{ padding: tokens.space(2) }}>Queue</th>
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
                          {(['claim', 'complete', 'block'] as const)
                            .filter((a) => allowedActions(t.state).includes(a))
                            .map((a) => (
                              <Button
                                key={a}
                                onClick={() => act(t, a)}
                                tone={a === 'complete' ? 'ok' : a === 'block' ? 'danger' : 'accent'}
                              >
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
          {selected ? <TaskDetail api={api} task={selected} /> : <Card><EmptyState>Select a task.</EmptyState></Card>}
        </div>
      </div>
    </PageShell>
  );
}

function TaskDetail({ api, task }: { api: ConsoleApi; task: Task }) {
  const [events, setEvents] = useState<Array<{ id: string; type: string; occurredAt: string }>>([]);
  const entityId = (task.subject['entityId'] as string | undefined) ?? '';

  useEffect(() => {
    if (!entityId) return;
    api.events(entityId).then(setEvents).catch(() => setEvents([]));
  }, [api, entityId]);

  return (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>{task.template}</div>
      <div style={{ color: tokens.color.textMuted, fontSize: '13px', marginBottom: tokens.space(3) }}>
        {task.ruleKey} v{task.ruleVersion} · {task.queue} · priority {task.priority}
      </div>
      <Toolbar>
        <Badge tone={STATE_TONE[task.state] ?? 'neutral'}>{task.state}</Badge>
        <Badge tone={SLA_TONE[slaStatus(task.slaDueAt)] ?? 'neutral'}>
          {formatSlaRemaining(task.slaDueAt)}
        </Badge>
      </Toolbar>

      <div style={{ fontWeight: 600, margin: `${tokens.space(4)} 0 ${tokens.space(2)}` }}>Event history</div>
      {events.length === 0 ? (
        <EmptyState>No events for this entity.</EmptyState>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px' }}>
          {events.map((e) => (
            <li key={e.id} style={{ borderTop: `1px solid ${tokens.color.border}`, padding: tokens.space(2) }}>
              <div>{e.type}</div>
              <div style={{ color: tokens.color.textMuted }}>{new Date(e.occurredAt).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
