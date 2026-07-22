import type { ReactNode, CSSProperties } from 'react';

// Shared component library for both consoles (operator + admin). Design tokens live here so the
// two consoles stay visually consistent; components are presentational and state-free.

export const tokens = {
  color: {
    bg: '#0f1115',
    surface: '#171a21',
    surfaceAlt: '#1e222b',
    border: '#2a2f3a',
    text: '#e6e8ee',
    textMuted: '#98a0b3',
    accent: '#5b8def',
    ok: '#3fb950',
    warn: '#d29922',
    danger: '#f85149',
  },
  radius: '8px',
  space: (n: number) => `${n * 4}px`,
} as const;

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius,
        padding: tokens.space(4),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const TONE_COLOR: Record<BadgeTone, string> = {
  neutral: tokens.color.textMuted,
  ok: tokens.color.ok,
  warn: tokens.color.warn,
  danger: tokens.color.danger,
  accent: tokens.color.accent,
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  const color = TONE_COLOR[tone];
  return (
    <span
      style={{
        color,
        border: `1px solid ${color}`,
        borderRadius: '999px',
        padding: `2px ${tokens.space(2)}`,
        fontSize: '12px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: BadgeTone;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? tokens.color.surfaceAlt : 'transparent',
        color: disabled ? tokens.color.textMuted : TONE_COLOR[tone],
        border: `1px solid ${disabled ? tokens.color.border : TONE_COLOR[tone]}`,
        borderRadius: tokens.radius,
        padding: `${tokens.space(1)} ${tokens.space(3)}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '13px',
      }}
    >
      {children}
    </button>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: tokens.space(2), alignItems: 'center' }}>{children}</div>;
}

export function PageShell({ title, sidebar, children }: { title: string; sidebar?: ReactNode; children: ReactNode }) {
  return (
    <div
      style={{
        background: tokens.color.bg,
        color: tokens.color.text,
        minHeight: '100vh',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <header
        style={{
          borderBottom: `1px solid ${tokens.color.border}`,
          padding: `${tokens.space(3)} ${tokens.space(5)}`,
          fontWeight: 600,
        }}
      >
        {title}
      </header>
      <div style={{ display: 'flex', gap: tokens.space(5), padding: tokens.space(5) }}>
        {sidebar ? <aside style={{ width: '220px', flexShrink: 0 }}>{sidebar}</aside> : null}
        <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ color: tokens.color.textMuted, padding: tokens.space(6), textAlign: 'center' }}>
      {children}
    </div>
  );
}
