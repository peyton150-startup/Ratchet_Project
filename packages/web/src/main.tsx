import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleApi } from './lib/api';
import { OperatorConsole } from './operator/OperatorConsole';
import { AdminConsole } from './admin/AdminConsole';
import { Button, Card, PageShell, tokens } from './components';

const STORAGE_KEY = 'ratchet.apiKey';

/**
 * Console entry. The API key is supplied by the operator and kept in localStorage — the demo has no
 * SSO (explicitly out of scope), so this is the deliberate stand-in for a login.
 */
function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const [draft, setDraft] = useState('');

  if (!apiKey) {
    return (
      <PageShell title="Ratchet — Sign in">
        <Card style={{ maxWidth: '420px' }}>
          <div style={{ marginBottom: tokens.space(3) }}>Enter an API key to open the console.</div>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="API key"
            style={{
              width: '100%',
              padding: tokens.space(2),
              marginBottom: tokens.space(3),
              background: tokens.color.surfaceAlt,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius,
              color: tokens.color.text,
            }}
          />
          <Button
            tone="accent"
            onClick={() => {
              localStorage.setItem(STORAGE_KEY, draft.trim());
              setApiKey(draft.trim());
            }}
          >
            Open console
          </Button>
        </Card>
      </PageShell>
    );
  }

  return <ConsoleSwitcher apiKey={apiKey} />;
}

/** Both consoles share one API instance (and therefore one WebSocket) and the component library. */
function ConsoleSwitcher({ apiKey }: { apiKey: string }) {
  const [view, setView] = useState<'operator' | 'admin'>('operator');
  const [api] = useState(() => new ConsoleApi({ apiKey }));

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
        <Button tone={view === 'operator' ? 'accent' : 'neutral'} onClick={() => setView('operator')}>
          Operator
        </Button>
        <Button tone={view === 'admin' ? 'accent' : 'neutral'} onClick={() => setView('admin')}>
          Admin
        </Button>
      </div>
      {view === 'operator' ? <OperatorConsole api={api} /> : <AdminConsole api={api} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
