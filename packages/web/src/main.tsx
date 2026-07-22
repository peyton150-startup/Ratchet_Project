import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleApi } from './lib/api';
import { OperatorConsole } from './operator/OperatorConsole';
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

  return <OperatorConsole api={new ConsoleApi({ apiKey })} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
