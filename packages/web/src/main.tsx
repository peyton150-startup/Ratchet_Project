import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RatchetClient, RatchetError } from '@workspace/sdk';
import { ConsoleApi } from './lib/api';
import { OperatorConsole } from './operator/OperatorConsole';
import { AdminConsole } from './admin/AdminConsole';
import { EventConsole } from './events/EventConsole';
import { Button, Card, PageShell, tokens } from './components';

const STORAGE_KEY = 'ratchet.apiKey';

/**
 * Where the API lives. In dev this is empty and the client falls back to the page origin, which the
 * Vite proxy forwards to :3000. In production the consoles are served as static files from a
 * different origin than the API, so the origin must be supplied explicitly at build time.
 */
const API_BASE_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || undefined;

/**
 * Console entry. The API key is supplied by the operator and kept in localStorage — the demo has no
 * SSO (explicitly out of scope), so this is the deliberate stand-in for a login.
 */
function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ask the API about the key before storing it. A rejected key that is stored anyway leaves every
  // later request failing with no route back to this screen.
  const signIn = async () => {
    const key = draft.trim();
    if (!key) return;
    setChecking(true);
    setError(null);
    try {
      await new RatchetClient({ baseUrl: API_BASE_URL ?? window.location.origin, apiKey: key }).graphql(
        '{ __typename }',
      );
      localStorage.setItem(STORAGE_KEY, key);
      setApiKey(key);
    } catch (e) {
      if (e instanceof RatchetError && e.status === 401) {
        setError('The API did not recognise that key. Paste the key on its own, without "Bearer".');
      } else if (e instanceof RatchetError) {
        setError(`The API rejected the request: ${e.message}`);
      } else {
        // fetch itself failed: the API is down, or it does not allow this page's origin (CORS).
        setError(`Could not reach the API from ${window.location.origin}. Is this the console's canonical URL?`);
      }
    } finally {
      setChecking(false);
    }
  };

  const signOut = () => {
    localStorage.removeItem(STORAGE_KEY);
    setDraft('');
    setApiKey('');
  };

  if (!apiKey) {
    return (
      <PageShell title="Ratchet — Sign in">
        <Card style={{ maxWidth: '420px' }}>
          <div style={{ marginBottom: tokens.space(3) }}>Enter an API key to open the console.</div>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void signIn();
            }}
            placeholder="API key"
            aria-label="API key"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: tokens.space(2),
              marginBottom: tokens.space(3),
              background: tokens.color.surfaceAlt,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius,
              color: tokens.color.text,
            }}
          />
          {error ? (
            <div role="alert" style={{ color: tokens.color.danger, fontSize: '13px', marginBottom: tokens.space(3) }}>
              {error}
            </div>
          ) : null}
          <Button tone="accent" onClick={() => void signIn()} disabled={checking || !draft.trim()}>
            {checking ? 'Checking…' : 'Open console'}
          </Button>
        </Card>
      </PageShell>
    );
  }

  return <ConsoleSwitcher key={apiKey} apiKey={apiKey} onSignOut={signOut} />;
}

const VIEWS = [
  { id: 'operator', label: 'Operator' },
  { id: 'admin', label: 'Admin' },
  { id: 'events', label: 'Send event' },
] as const;
type View = (typeof VIEWS)[number]['id'];

/** The views share one API instance (and therefore one WebSocket) and the component library. */
function ConsoleSwitcher({ apiKey, onSignOut }: { apiKey: string; onSignOut: () => void }) {
  const [view, setView] = useState<View>('operator');
  const [api] = useState(() => new ConsoleApi({ apiKey, baseUrl: API_BASE_URL }));

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: tokens.space(2),
          padding: tokens.space(3),
          background: tokens.color.bg,
          borderBottom: `1px solid ${tokens.color.border}`,
        }}
      >
        {VIEWS.map((v) => (
          <Button key={v.id} tone={view === v.id ? 'accent' : 'neutral'} onClick={() => setView(v.id)}>
            {v.label}
          </Button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          <Button
            onClick={() => {
              api.dispose();
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
      {view === 'operator' ? <OperatorConsole api={api} /> : null}
      {view === 'admin' ? <AdminConsole api={api} /> : null}
      {/* Kept mounted: the form and the log of what was sent survive a trip to the Operator view. */}
      <div style={{ display: view === 'events' ? 'block' : 'none' }}>
        <EventConsole api={api} visible={view === 'events'} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
