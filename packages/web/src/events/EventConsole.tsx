import { useEffect, useMemo, useState } from 'react';
import { RatchetError, type EventInput } from '@workspace/sdk';
import type { ConsoleApi, RuleVersion } from '../lib/api';
import { EVENT_TYPES, parseJsonObject, rulesListeningTo, sampleFor, type EventType } from '../lib/events';
import { Badge, Button, Card, EmptyState, PageShell, Toolbar, tokens, type BadgeTone } from '../components';

const inputStyle = {
  background: tokens.color.surfaceAlt,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius,
  color: tokens.color.text,
  padding: tokens.space(2),
  fontSize: '13px',
  width: '100%',
  boxSizing: 'border-box',
} as const;

const labelStyle = { fontSize: '13px', display: 'block', marginBottom: tokens.space(3) } as const;

type Outcome = 'accepted' | 'duplicate' | 'failed';

const OUTCOME_TONE: Record<Outcome, BadgeTone> = { accepted: 'ok', duplicate: 'warn', failed: 'danger' };

interface SentEvent {
  /** Unique per attempt, so a resend of the same event gets its own row. */
  attempt: number;
  event: EventInput;
  outcome: Outcome;
  detail: string;
}

const pretty = (value: Record<string, unknown>): string => JSON.stringify(value, null, 2);

function failureText(e: unknown): string {
  if (e instanceof RatchetError && e.status === 403) {
    return 'This key cannot send events. Use an admin or integrator key.';
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Post events to the ingest API from the console. Events normally come from client systems; this is
 * the stand-in for one, so a demo needs nothing but a browser.
 */
export function EventConsole({ api, visible = true }: { api: ConsoleApi; visible?: boolean }) {
  const [type, setType] = useState<EventType>(EVENT_TYPES[0]);
  const [entityId, setEntityId] = useState(() => sampleFor(EVENT_TYPES[0]).entityId);
  const [payloadText, setPayloadText] = useState(() => pretty(sampleFor(EVENT_TYPES[0]).payload));
  const [deltaText, setDeltaText] = useState(() => pretty(sampleFor(EVENT_TYPES[0]).delta));
  const [rules, setRules] = useState<RuleVersion[] | null>(null);
  const [sent, setSent] = useState<SentEvent[]>([]);
  const [sending, setSending] = useState(false);

  // A key that cannot read rules (integrator) can still send events; it just gets no rule hints.
  // Re-read each time the view is shown: it stays mounted, and rules may have been published since.
  useEffect(() => {
    if (!visible) return;
    api.rules().then(setRules).catch(() => setRules(null));
  }, [api, visible]);

  const chooseType = (next: EventType) => {
    const sample = sampleFor(next);
    setType(next);
    setEntityId(sample.entityId);
    setPayloadText(pretty(sample.payload));
    setDeltaText(pretty(sample.delta));
  };

  const payload = parseJsonObject(payloadText);
  const delta = parseJsonObject(deltaText);
  const problems = [
    entityId.trim() ? null : 'Entity ID is required',
    payload.ok ? null : `Payload ${payload.message}`,
    delta.ok ? null : `Delta ${delta.message}`,
  ].filter((p): p is string => p !== null);

  const listening = useMemo(() => (rules ? rulesListeningTo(type, rules) : null), [rules, type]);

  const post = async (event: EventInput) => {
    setSending(true);
    let outcome: Outcome;
    let detail: string;
    try {
      const result = await api.ingest(event);
      outcome = result.duplicate ? 'duplicate' : 'accepted';
      detail = result.duplicate
        ? `Already received as ${result.eventId}; no new tasks are created.`
        : `Stored as ${result.eventId}. Tasks it creates appear in the Operator view.`;
    } catch (e) {
      outcome = 'failed';
      detail = failureText(e);
    }
    setSent((current) => [{ attempt: current.length + 1, event, outcome, detail }, ...current]);
    setSending(false);
  };

  const send = () => {
    if (!payload.ok || !delta.ok) return;
    void post({
      // A fresh key per send: sending the form twice is two events. "send again" below reuses one.
      idempotencyKey: crypto.randomUUID(),
      type,
      entityId: entityId.trim(),
      payload: payload.value,
      delta: delta.value,
    });
  };

  return (
    <PageShell title="Ratchet — Send Test Event">
      <div style={{ display: 'flex', gap: tokens.space(4), alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Event</div>
            <label style={labelStyle}>
              Event type
              <select style={inputStyle} value={type} onChange={(e) => chooseType(e.target.value as EventType)}>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Entity ID
              <input style={inputStyle} value={entityId} onChange={(e) => setEntityId(e.target.value)} />
            </label>
            <label style={labelStyle}>
              Payload (JSON)
              <textarea
                style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
                rows={5}
                spellCheck={false}
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
              />
            </label>
            <label style={labelStyle}>
              Delta: fields that changed (JSON)
              <textarea
                style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
                rows={3}
                spellCheck={false}
                value={deltaText}
                onChange={(e) => setDeltaText(e.target.value)}
              />
            </label>
            <Button tone="accent" onClick={send} disabled={problems.length > 0 || sending}>
              {sending ? 'Sending…' : 'Send event'}
            </Button>
            {problems.length > 0 ? (
              <ul style={{ color: tokens.color.warn, fontSize: '13px', marginTop: tokens.space(2) }}>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </Card>

          {listening ? (
            <div style={{ marginTop: tokens.space(3) }}>
              <Card>
                <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Rules listening for {type}</div>
                {listening.length === 0 ? (
                  <div style={{ color: tokens.color.textMuted, fontSize: '13px' }}>
                    No active rule is triggered by this event, so it creates no tasks.
                  </div>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px' }}>
                    {listening.map((r) => (
                      <li
                        key={r.ruleKey}
                        style={{ borderTop: `1px solid ${tokens.color.border}`, padding: `${tokens.space(2)} 0` }}
                      >
                        <strong>{r.ruleKey}</strong> {r.outcome}
                        <div style={{ color: tokens.color.textMuted }}>
                          {r.condition === 'always' ? 'always' : `when ${r.condition}`}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          ) : null}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Sent this session</div>
            {sent.length === 0 ? (
              <EmptyState>Nothing sent yet.</EmptyState>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px' }}>
                {sent.map((s) => (
                  <li
                    key={s.attempt}
                    style={{ borderTop: `1px solid ${tokens.color.border}`, padding: `${tokens.space(2)} 0` }}
                  >
                    <Toolbar>
                      <Badge tone={OUTCOME_TONE[s.outcome]}>{s.outcome}</Badge>
                      <span>
                        {s.event.type} · {s.event.entityId}
                      </span>
                    </Toolbar>
                    <div style={{ color: tokens.color.textMuted, margin: `${tokens.space(2)} 0` }}>{s.detail}</div>
                    <Button onClick={() => void post(s.event)} disabled={sending}>
                      send again (same key)
                    </Button>
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
