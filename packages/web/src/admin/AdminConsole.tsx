import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConsoleApi, RuleVersion } from '../lib/api';
import {
  COMPARISON_OPS,
  STATE_PREDICATES,
  EVENT_TYPES,
  addToGroup,
  describeCondition,
  diffVersions,
  isGroup,
  removeFromGroup,
  validateDraft,
  wrapInGroup,
  type Condition,
  type RuleDraft,
} from '../lib/rules';
import { Badge, Button, Card, EmptyState, PageShell, Toolbar, tokens } from '../components';

const emptyDraft = (): RuleDraft => ({
  ruleKey: '',
  trigger: { type: 'event', event: 'application.submitted' },
  condition: null,
  action: { kind: 'create_task', queue: 'intake', sla: '4h', template: '' },
});

const inputStyle = {
  background: tokens.color.surfaceAlt,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius,
  color: tokens.color.text,
  padding: tokens.space(2),
  fontSize: '13px',
} as const;

export function AdminConsole({ api }: { api: ConsoleApi }) {
  const [versions, setVersions] = useState<RuleVersion[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft());
  const [dryRun, setDryRun] = useState<{ matched: boolean; decision: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.rules().then(setVersions).catch((e) => setError(String(e)));
  }, [api]);

  useEffect(refresh, [refresh]);

  const ruleKeys = useMemo(() => [...new Set(versions.map((v) => v.ruleKey))].sort(), [versions]);
  const selectedVersions = useMemo(
    () => versions.filter((v) => v.ruleKey === selectedKey).sort((a, b) => b.version - a.version),
    [versions, selectedKey],
  );
  const issues = validateDraft(draft);

  const publish = async () => {
    setError(null);
    try {
      await api.createRuleVersion(draft);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const preview = async () => {
    setError(null);
    try {
      const sample = {
        type: draft.trigger.type === 'event' ? draft.trigger.event : 'application.updated',
        entityId: 'sample-entity',
        entityType: 'LoanApplication',
        occurredAt: new Date().toISOString(),
        payload: {},
        delta: {},
      };
      setDryRun(await api.dryRunRule(draft, sample));
    } catch (e) {
      setError(String(e));
    }
  };

  const sidebar = (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Rules</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(2) }}>
        {ruleKeys.length === 0 ? <EmptyState>No rules yet.</EmptyState> : null}
        {ruleKeys.map((k) => (
          <Button key={k} tone={selectedKey === k ? 'accent' : 'neutral'} onClick={() => setSelectedKey(k)}>
            {k}
          </Button>
        ))}
      </div>
    </Card>
  );

  return (
    <PageShell title="Ratchet — Admin Console" sidebar={sidebar}>
      {error ? <div style={{ color: tokens.color.danger, marginBottom: tokens.space(3) }}>{error}</div> : null}

      <div style={{ display: 'flex', gap: tokens.space(4), alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <RuleBuilder draft={draft} onChange={setDraft} />
          <div style={{ marginTop: tokens.space(3) }}>
            <Toolbar>
              <Button tone="accent" onClick={preview} disabled={issues.length > 0}>
                Dry run
              </Button>
              <Button tone="ok" onClick={publish} disabled={issues.length > 0}>
                Publish version
              </Button>
            </Toolbar>
          </div>
          {issues.length > 0 ? (
            <ul style={{ color: tokens.color.warn, fontSize: '13px', marginTop: tokens.space(2) }}>
              {issues.map((i) => (
                <li key={i.field}>{i.message}</li>
              ))}
            </ul>
          ) : null}

          {dryRun ? (
            <div style={{ marginTop: tokens.space(3) }}>
              <Card>
                <Toolbar>
                  <strong>Dry run</strong>
                  <Badge tone={dryRun.matched ? 'ok' : 'neutral'}>
                    {dryRun.matched ? 'would fire' : 'would not fire'}
                  </Badge>
                </Toolbar>
                {dryRun.decision ? (
                  <pre style={{ fontSize: '12px', color: tokens.color.textMuted, overflowX: 'auto' }}>
                    {JSON.stringify(dryRun.decision, null, 2)}
                  </pre>
                ) : null}
              </Card>
            </div>
          ) : null}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <VersionHistory versions={selectedVersions} />
        </div>
      </div>
    </PageShell>
  );
}

function RuleBuilder({ draft, onChange }: { draft: RuleDraft; onChange: (d: RuleDraft) => void }) {
  const addCondition = (child: Condition) => {
    const base = draft.condition && isGroup(draft.condition) ? draft.condition : wrapInGroup(draft.condition, 'and');
    onChange({ ...draft, condition: addToGroup(base, child) });
  };

  const children =
    draft.condition && isGroup(draft.condition)
      ? ((draft.condition as Record<string, Condition[]>)['and'] ??
         (draft.condition as Record<string, Condition[]>)['or'] ?? [])
      : [];

  return (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Rule builder</div>

      <div style={{ display: 'grid', gap: tokens.space(2), gridTemplateColumns: '1fr 1fr' }}>
        <label style={{ fontSize: '13px' }}>
          Rule key
          <input
            style={{ ...inputStyle, width: '100%' }}
            value={draft.ruleKey}
            onChange={(e) => onChange({ ...draft, ruleKey: e.target.value })}
            placeholder="R13"
          />
        </label>
        <label style={{ fontSize: '13px' }}>
          When event
          <select
            style={{ ...inputStyle, width: '100%' }}
            value={draft.trigger.type === 'event' ? draft.trigger.event : ''}
            onChange={(e) => onChange({ ...draft, trigger: { type: 'event', event: e.target.value } })}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ margin: `${tokens.space(4)} 0 ${tokens.space(2)}`, fontWeight: 600 }}>Condition</div>
      <div style={{ fontSize: '13px', color: tokens.color.textMuted, marginBottom: tokens.space(2) }}>
        {describeCondition(draft.condition)}
      </div>
      <Toolbar>
        <Button onClick={() => addCondition({ changed: 'amount' })}>+ changed(field)</Button>
        <Button onClick={() => addCondition({ state: STATE_PREDICATES[0] })}>+ state predicate</Button>
        <Button onClick={() => addCondition({ [COMPARISON_OPS[0]]: ['payload.amount', 0] } as Condition)}>
          + comparison
        </Button>
        <Button tone="danger" onClick={() => onChange({ ...draft, condition: null })}>
          clear
        </Button>
      </Toolbar>

      {children.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: tokens.space(2), fontSize: '13px' }}>
          {children.map((child, i) => (
            <li
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderTop: `1px solid ${tokens.color.border}`,
                padding: tokens.space(2),
              }}
            >
              <span>{describeCondition(child)}</span>
              <Button
                tone="danger"
                onClick={() => onChange({ ...draft, condition: removeFromGroup(draft.condition!, i) })}
              >
                remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div style={{ margin: `${tokens.space(4)} 0 ${tokens.space(2)}`, fontWeight: 600 }}>Action</div>
      {draft.action.kind === 'create_task' ? (
        <CreateTaskFields
          action={draft.action}
          onChange={(action) => onChange({ ...draft, action })}
        />
      ) : (
        <div style={{ fontSize: '13px', color: tokens.color.textMuted }}>
          cancel_tasks — scope {draft.action.scope}
        </div>
      )}
    </Card>
  );
}

type CreateTaskAction = Extract<RuleDraft['action'], { kind: 'create_task' }>;

function CreateTaskFields({
  action,
  onChange,
}: {
  action: CreateTaskAction;
  onChange: (a: CreateTaskAction) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: tokens.space(2), gridTemplateColumns: '1fr 1fr 1fr' }}>
      <label style={{ fontSize: '13px' }}>
        Queue
        <input
          style={{ ...inputStyle, width: '100%' }}
          value={action.queue}
          onChange={(e) => onChange({ ...action, queue: e.target.value })}
        />
      </label>
      <label style={{ fontSize: '13px' }}>
        SLA
        <input
          style={{ ...inputStyle, width: '100%' }}
          value={action.sla}
          onChange={(e) => onChange({ ...action, sla: e.target.value })}
          placeholder="4h"
        />
      </label>
      <label style={{ fontSize: '13px' }}>
        Task template
        <input
          style={{ ...inputStyle, width: '100%' }}
          value={action.template}
          onChange={(e) => onChange({ ...action, template: e.target.value })}
        />
      </label>
    </div>
  );
}

function VersionHistory({ versions }: { versions: RuleVersion[] }) {
  if (versions.length === 0) {
    return (
      <Card>
        <EmptyState>Select a rule to see its version history.</EmptyState>
      </Card>
    );
  }
  return (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Version history</div>
      {versions.map((v, i) => {
        const previous = versions[i + 1];
        const diffs = previous ? diffVersions(previous, v) : [];
        return (
          <div key={v.version} style={{ borderTop: `1px solid ${tokens.color.border}`, padding: tokens.space(2) }}>
            <Toolbar>
              <strong>v{v.version}</strong>
              {v.active ? <Badge tone="ok">active</Badge> : <Badge>superseded</Badge>}
              <span style={{ color: tokens.color.textMuted, fontSize: '12px' }}>
                {new Date(v.createdAt).toLocaleString()}
              </span>
            </Toolbar>
            {previous ? (
              diffs.length === 0 ? (
                <div style={{ color: tokens.color.textMuted, fontSize: '13px' }}>No changes from v{previous.version}</div>
              ) : (
                <ul style={{ fontSize: '13px', margin: `${tokens.space(2)} 0 0`, paddingLeft: tokens.space(4) }}>
                  {diffs.map((d) => (
                    <li key={d.field}>
                      <span style={{ color: tokens.color.textMuted }}>{d.field}: </span>
                      <span style={{ color: tokens.color.danger }}>{d.before}</span>
                      {' → '}
                      <span style={{ color: tokens.color.ok }}>{d.after}</span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <div style={{ color: tokens.color.textMuted, fontSize: '13px' }}>initial version</div>
            )}
          </div>
        );
      })}
    </Card>
  );
}
