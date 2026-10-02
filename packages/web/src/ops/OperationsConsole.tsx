import { useCallback, useEffect, useState } from 'react';
import type { Agent, ConsoleApi, DeadLetter, QueueInfo } from '../lib/api';
import { describeStrategy } from '../lib/audit';
import { Badge, Button, Card, EmptyState, PageShell, Toolbar, tokens, type BadgeTone } from '../components';

const muted = { color: tokens.color.textMuted, fontSize: '13px' } as const;
const cell = { padding: tokens.space(2), verticalAlign: 'top' } as const;
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } as const;
const headRow = { color: tokens.color.textMuted, textAlign: 'left' } as const;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Full is a warning, over capacity a problem: routing by capacity skips an agent once it is full. */
function loadTone(agent: Agent): BadgeTone {
  if (agent.load > agent.capacity) return 'danger';
  if (agent.load === agent.capacity) return 'warn';
  return 'ok';
}

/**
 * The system's working state for an admin: where tasks are waiting, who they are routed to and how
 * loaded each agent is, and which messages failed for good.
 */
export function OperationsConsole({ api }: { api: ConsoleApi }) {
  const [queues, setQueues] = useState<QueueInfo[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [deadLetterError, setDeadLetterError] = useState<string | null>(null);

  // Two requests on purpose: a key that may see the team but not dead letters still gets the team.
  const refresh = useCallback(() => {
    api
      .team()
      .then((team) => {
        setQueues(team.queues);
        setAgents(team.agents);
        setTeamError(null);
      })
      .catch((e) => setTeamError(errorText(e)));
    api
      .deadLetters()
      .then((rows) => {
        setDeadLetters(rows);
        setDeadLetterError(null);
      })
      .catch((e) => setDeadLetterError(errorText(e)));
  }, [api]);

  useEffect(refresh, [refresh]);

  const membersOf = (queue: string): string =>
    agents
      .filter((a) => a.queues.includes(queue))
      .map((a) => a.name)
      .join(', ') || 'nobody';

  return (
    <PageShell title="Ratchet — Operations">
      <Toolbar>
        <Button onClick={refresh}>Refresh</Button>
        <span style={muted}>A snapshot; it does not update on its own.</span>
      </Toolbar>

      {teamError ? (
        <div role="alert" style={{ color: tokens.color.danger, marginTop: tokens.space(3) }}>
          {teamError}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: tokens.space(4), alignItems: 'flex-start', marginTop: tokens.space(4) }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Queues</div>
            {queues.length === 0 ? (
              <EmptyState>No queues configured.</EmptyState>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={headRow}>
                    <th style={cell}>Queue</th>
                    <th style={cell}>Waiting</th>
                    <th style={cell}>Routes to</th>
                    <th style={cell}>Agents</th>
                  </tr>
                </thead>
                <tbody>
                  {queues.map((q) => (
                    <tr key={q.name} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                      <td style={cell}>
                        {q.name} {q.active ? null : <Badge>inactive</Badge>}
                      </td>
                      <td style={cell}>{q.activeTasks}</td>
                      <td style={cell}>{describeStrategy(q.strategy, q.requiredSkill)}</td>
                      <td style={cell}>{membersOf(q.name)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div style={{ marginTop: tokens.space(3) }}>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Agents</div>
              {agents.length === 0 ? (
                <EmptyState>No agents configured.</EmptyState>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr style={headRow}>
                      <th style={cell}>Agent</th>
                      <th style={cell}>Load</th>
                      <th style={cell}>Skills</th>
                      <th style={cell}>Queues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((a) => (
                      <tr key={a.id} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                        <td style={cell}>
                          {a.name} {a.active ? null : <Badge>inactive</Badge>}
                        </td>
                        <td style={cell}>
                          <Badge tone={loadTone(a)}>
                            {a.load} of {a.capacity}
                          </Badge>
                        </td>
                        <td style={cell}>{a.skills.join(', ') || '—'}</td>
                        <td style={cell}>{a.queues.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Dead letters</div>
            <div style={{ ...muted, marginBottom: tokens.space(2) }}>
              Messages that failed every retry. Re-drive them from a shell with the redrive-dlq script.
            </div>
            {deadLetterError ? (
              <div role="alert" style={{ color: tokens.color.danger }}>
                {deadLetterError}
              </div>
            ) : deadLetters.length === 0 ? (
              <EmptyState>None. Nothing has failed for good.</EmptyState>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px' }}>
                {deadLetters.map((d) => (
                  <li
                    key={d.id}
                    style={{ borderTop: `1px solid ${tokens.color.border}`, padding: `${tokens.space(2)} 0` }}
                  >
                    <details>
                      <summary style={{ cursor: 'pointer' }}>
                        <span style={{ color: tokens.color.danger }}>{d.error}</span>
                        <span style={muted}>
                          {' '}
                          · {d.source}
                          {d.reference ? ` · ${d.reference}` : ''} ·{' '}
                          {d.attempts === 1 ? '1 attempt' : `${d.attempts} attempts`} ·{' '}
                          {new Date(d.createdAt).toLocaleString()}
                        </span>
                      </summary>
                      <pre style={{ fontSize: '12px', color: tokens.color.textMuted, overflowX: 'auto' }}>
                        {JSON.stringify(d.payload, null, 2)}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
