import { useCallback, useEffect, useState } from 'react';
import {
  RatchetError,
  WEBHOOK_EVENTS,
  type RegisteredWebhook,
  type Webhook,
  type WebhookDelivery,
} from '@workspace/sdk';
import type { ConsoleApi } from '../lib/api';
import { Badge, Button, Card, EmptyState, PageShell, Toolbar, tokens } from '../components';

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

const muted = { color: tokens.color.textMuted, fontSize: '13px' } as const;

function failureText(e: unknown): string {
  if (e instanceof RatchetError && e.status === 403) {
    return 'This key cannot manage webhooks. Use an admin or integrator key.';
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Webhook management for integrators: register an endpoint, pause or resume it, and see what was
 * delivered to it. The signing secret is shown once, at registration, because the API never returns
 * it again.
 */
export function WebhooksConsole({ api }: { api: ConsoleApi }) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...WEBHOOK_EVENTS]);
  const [registered, setRegistered] = useState<RegisteredWebhook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.webhooks().then(setWebhooks).catch((e) => setError(failureText(e)));
  }, [api]);

  useEffect(refresh, [refresh]);

  const toggleEvent = (event: string) =>
    setEvents((current) => (current.includes(event) ? current.filter((e) => e !== event) : [...current, event]));

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      setRegistered(await api.registerWebhook({ url: url.trim(), events }));
      setUrl('');
      refresh();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (webhook: Webhook, active: boolean) => {
    setError(null);
    try {
      const updated = await api.setWebhookActive(webhook.id, active);
      setWebhooks((current) => current.map((w) => (w.id === updated.id ? updated : w)));
    } catch (e) {
      setError(failureText(e));
    }
  };

  const problems = [
    url.trim() ? null : 'Endpoint URL is required',
    events.length > 0 ? null : 'Choose at least one notification',
  ].filter((p): p is string => p !== null);

  return (
    <PageShell title="Ratchet — Webhooks">
      {error ? (
        <div role="alert" style={{ color: tokens.color.danger, marginBottom: tokens.space(3) }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: tokens.space(4), alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Register an endpoint</div>
            <label style={{ fontSize: '13px', display: 'block', marginBottom: tokens.space(3) }}>
              Endpoint URL
              <input
                style={inputStyle}
                value={url}
                placeholder="https://example.com/ratchet-hook"
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <div style={{ fontSize: '13px', marginBottom: tokens.space(3) }}>
              Notify on
              {WEBHOOK_EVENTS.map((event) => (
                <label key={event} style={{ display: 'block', marginTop: tokens.space(1) }}>
                  <input type="checkbox" checked={events.includes(event)} onChange={() => toggleEvent(event)} />{' '}
                  {event}
                </label>
              ))}
            </div>
            <Button tone="accent" onClick={() => void register()} disabled={problems.length > 0 || busy}>
              {busy ? 'Registering…' : 'Register webhook'}
            </Button>
            <div style={{ ...muted, marginTop: tokens.space(2) }}>
              Each call is signed. Addresses that resolve to private or internal networks are refused.
            </div>
          </Card>

          {registered ? (
            <div style={{ marginTop: tokens.space(3) }}>
              <Card style={{ borderColor: tokens.color.warn }}>
                <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Signing secret: copy it now</div>
                <div style={muted}>
                  It verifies calls to {registered.url}. It is shown once and cannot be retrieved later.
                </div>
                <pre
                  style={{
                    fontSize: '13px',
                    overflowX: 'auto',
                    background: tokens.color.surfaceAlt,
                    padding: tokens.space(2),
                    borderRadius: tokens.radius,
                    userSelect: 'all',
                  }}
                >
                  {registered.secret}
                </pre>
                <Button onClick={() => setRegistered(null)}>I have copied it</Button>
              </Card>
            </div>
          ) : null}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Registered endpoints</div>
            {webhooks.length === 0 ? (
              <EmptyState>No webhooks registered.</EmptyState>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px' }}>
                {webhooks.map((w) => (
                  <li
                    key={w.id}
                    style={{ borderTop: `1px solid ${tokens.color.border}`, padding: `${tokens.space(2)} 0` }}
                  >
                    <WebhookRow api={api} webhook={w} onSetActive={(active) => void setActive(w, active)} />
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

function WebhookRow({
  api,
  webhook,
  onSetActive,
}: {
  api: ConsoleApi;
  webhook: Webhook;
  onSetActive: (active: boolean) => void;
}) {
  // null: not loaded (the log is closed). Loaded on demand, since most rows are never opened.
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  const toggleLog = () => {
    if (deliveries !== null) {
      setDeliveries(null);
      return;
    }
    setLogError(null);
    api
      .webhookDeliveries(webhook.id)
      .then(setDeliveries)
      .catch((e) => setLogError(failureText(e)));
  };

  return (
    <>
      <div style={{ wordBreak: 'break-all', marginBottom: tokens.space(2) }}>{webhook.url}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space(2), alignItems: 'center' }}>
        <Badge tone={webhook.active ? 'ok' : 'neutral'}>{webhook.active ? 'active' : 'paused'}</Badge>
        <span style={muted}>{webhook.events.join(', ')}</span>
        <Button onClick={() => onSetActive(!webhook.active)}>{webhook.active ? 'pause' : 'resume'}</Button>
        <Button onClick={toggleLog}>{deliveries === null ? 'show deliveries' : 'hide deliveries'}</Button>
      </div>
      {logError ? <div style={{ color: tokens.color.danger, marginTop: tokens.space(2) }}>{logError}</div> : null}
      {deliveries === null ? null : deliveries.length === 0 ? (
        <div style={{ ...muted, marginTop: tokens.space(2) }}>Nothing has been sent to this endpoint yet.</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: `${tokens.space(2)} 0 0` }}>
          {deliveries.map((d) => (
            <li key={d.id} style={{ padding: `${tokens.space(1)} 0` }}>
              <Toolbar>
                <Badge tone={d.status === 'delivered' ? 'ok' : 'danger'}>{d.status}</Badge>
                <span>{d.eventType}</span>
                <span style={muted}>
                  {d.responseStatus === null ? 'not sent' : `HTTP ${d.responseStatus}`} ·{' '}
                  {d.attempts === 1 ? '1 attempt' : `${d.attempts} attempts`} ·{' '}
                  {new Date(d.createdAt).toLocaleString()}
                </span>
              </Toolbar>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
