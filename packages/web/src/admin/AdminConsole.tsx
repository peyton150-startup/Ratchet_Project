import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { entityTypeFor } from '@workspace/sdk';
import type { AuditEntry, ConsoleApi, RuleVersion } from '../lib/api';
import { auditOutcome, auditTrigger } from '../lib/audit';
import { parseJsonObject, sampleFor, type EventType } from '../lib/events';
import {
  CANCEL_SCOPES,
  EVENT_TYPES,
  SCAN_PREDICATES,
  describeAction,
  describeCondition,
  describeTrigger,
  diffVersions,
  draftFromVersion,
  sortRuleKeys,
  validateDraft,
  type Condition,
  type RuleDraft,
} from '../lib/rules';
import { Badge, Button, Card, EmptyState, PageShell, Toolbar, tokens } from '../components';
import { ConditionEditor } from './ConditionEditor';

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
  width: '100%',
  boxSizing: 'border-box',
} as const;

const sectionTitle = { margin: `${tokens.space(4)} 0 ${tokens.space(2)}`, fontWeight: 600 } as const;
const mutedNote = { fontSize: '13px', color: tokens.color.textMuted } as const;

const pretty = (value: Record<string, unknown>): string => JSON.stringify(value, null, 2);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const eventOf = (draft: RuleDraft): string | null => (draft.trigger.type === 'event' ? draft.trigger.event : null);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ fontSize: '13px' }}>
      {label}
      {children}
    </label>
  );
}

export function AdminConsole({ api }: { api: ConsoleApi }) {
  const [versions, setVersions] = useState<RuleVersion[]>([]);
  const [queues, setQueues] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft());
  const [samplePayload, setSamplePayload] = useState(() => pretty(sampleFor('application.submitted').payload));
  const [sampleDelta, setSampleDelta] = useState(() => pretty(sampleFor('application.submitted').delta));
  const [dryRun, setDryRun] = useState<{ matched: boolean; decision: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.rules().then(setVersions).catch((e) => setError(errorText(e)));
  }, [api]);

  useEffect(refresh, [refresh]);

  // The queue picker is a convenience; without the list the field falls back to free text.
  useEffect(() => {
    api.queues().then((qs) => setQueues(qs.map((q) => q.name))).catch(() => setQueues([]));
  }, [api]);

  const ruleKeys = useMemo(() => sortRuleKeys([...new Set(versions.map((v) => v.ruleKey))]), [versions]);
  const versionsOf = useCallback(
    (key: string) => versions.filter((v) => v.ruleKey === key).sort((a, b) => b.version - a.version),
    [versions],
  );
  const selectedVersions = useMemo(() => (selectedKey ? versionsOf(selectedKey) : []), [selectedKey, versionsOf]);

  // Every edit goes through here: a dry-run result or a "published" notice describes the draft as it
  // was, and the sample event has to match the event type the rule now listens to.
  const applyDraft = (next: RuleDraft) => {
    const event = eventOf(next);
    if (event && event !== eventOf(draft)) {
      const sample = sampleFor(event as EventType);
      setSamplePayload(pretty(sample.payload));
      setSampleDelta(pretty(sample.delta));
    }
    setDraft(next);
    setDryRun(null);
    setNotice(null);
  };

  const selectRule = (key: string) => {
    const stored = versionsOf(key);
    const current = stored.find((v) => v.active) ?? stored[0];
    setSelectedKey(key);
    if (current) applyDraft(draftFromVersion(current));
  };

  const newRule = () => {
    setSelectedKey(null);
    applyDraft(emptyDraft());
  };

  const issues = validateDraft(draft);
  const payload = parseJsonObject(samplePayload);
  const delta = parseJsonObject(sampleDelta);
  const sampleProblems = [
    payload.ok ? null : `Sample payload ${payload.message}`,
    delta.ok ? null : `Sample delta ${delta.message}`,
  ].filter((p): p is string => p !== null);

  const key = draft.ruleKey.trim();
  const latest = key ? versionsOf(key)[0] : undefined;

  const publish = async () => {
    setError(null);
    try {
      const published = await api.createRuleVersion({ ...draft, ruleKey: key });
      setNotice(`Published ${published.ruleKey} v${published.version}.`);
      setSelectedKey(key);
      refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const preview = async () => {
    const event = eventOf(draft);
    if (!event || !payload.ok || !delta.ok) return;
    setError(null);
    try {
      const sample = {
        type: event,
        entityId: sampleFor(event as EventType).entityId,
        entityType: entityTypeFor(event as EventType),
        occurredAt: new Date().toISOString(),
        payload: payload.value,
        delta: delta.value,
      };
      // Numbered as the version publishing would create, so the decision shown matches what follows.
      setDryRun(await api.dryRunRule({ ...draft, ruleKey: key, version: (latest?.version ?? 0) + 1 }, sample));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const sidebar = (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Rules</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(2) }}>
        <Button tone={selectedKey === null ? 'accent' : 'neutral'} onClick={newRule}>
          + New rule
        </Button>
        {ruleKeys.length === 0 ? <EmptyState>No rules yet.</EmptyState> : null}
        {ruleKeys.map((k) => (
          <Button key={k} tone={selectedKey === k ? 'accent' : 'neutral'} onClick={() => selectRule(k)}>
            {k}
          </Button>
        ))}
      </div>
    </Card>
  );

  const isEvent = draft.trigger.type === 'event';

  return (
    <PageShell title="Ratchet — Admin Console" sidebar={sidebar}>
      {error ? (
        <div role="alert" style={{ color: tokens.color.danger, marginBottom: tokens.space(3) }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: tokens.space(4), alignItems: 'flex-start' }}>
        <div style={{ flex: 3, minWidth: 0 }}>
          <RuleBuilder draft={draft} queues={queues} onChange={applyDraft} />

          <div style={{ marginTop: tokens.space(3) }}>
            <Card>
              <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Try it and publish</div>
              {isEvent ? (
                <div style={{ display: 'grid', gap: tokens.space(2), gridTemplateColumns: '1fr 1fr' }}>
                  <Field label="Sample payload (JSON)">
                    <textarea
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
                      rows={4}
                      spellCheck={false}
                      value={samplePayload}
                      onChange={(e) => {
                        setSamplePayload(e.target.value);
                        setDryRun(null);
                      }}
                    />
                  </Field>
                  <Field label="Sample delta (JSON)">
                    <textarea
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
                      rows={4}
                      spellCheck={false}
                      value={sampleDelta}
                      onChange={(e) => {
                        setSampleDelta(e.target.value);
                        setDryRun(null);
                      }}
                    />
                  </Field>
                </div>
              ) : (
                <div style={mutedNote}>
                  Dry run tests a rule against a sample event, so it does not apply to a scheduled rule.
                </div>
              )}

              <div style={{ marginTop: tokens.space(3) }}>
                <Toolbar>
                  <Button
                    tone="accent"
                    onClick={preview}
                    disabled={!isEvent || issues.length > 0 || sampleProblems.length > 0}
                  >
                    Dry run
                  </Button>
                  <Button tone="ok" onClick={publish} disabled={issues.length > 0}>
                    Publish version
                  </Button>
                  {dryRun ? (
                    <Badge tone={dryRun.matched ? 'ok' : 'neutral'}>
                      {dryRun.matched ? 'would fire' : 'would not fire'}
                    </Badge>
                  ) : null}
                </Toolbar>
              </div>

              {key ? (
                <div style={{ ...mutedNote, marginTop: tokens.space(2) }}>
                  {latest
                    ? `Publishing creates ${key} v${latest.version + 1} and supersedes v${latest.version}.`
                    : `Publishing creates ${key} v1.`}{' '}
                  It applies to live events straight away.
                </div>
              ) : null}
              {notice ? (
                <div style={{ color: tokens.color.ok, fontSize: '13px', marginTop: tokens.space(2) }}>{notice}</div>
              ) : null}

              {issues.length + sampleProblems.length > 0 ? (
                <ul style={{ color: tokens.color.warn, fontSize: '13px', marginTop: tokens.space(2) }}>
                  {[...issues.map((i) => i.message), ...sampleProblems].map((message, i) => (
                    <li key={i}>{message}</li>
                  ))}
                </ul>
              ) : null}

              {dryRun?.decision ? (
                <pre style={{ fontSize: '12px', color: tokens.color.textMuted, overflowX: 'auto' }}>
                  {JSON.stringify(dryRun.decision, null, 2)}
                </pre>
              ) : null}
            </Card>
          </div>
        </div>

        <div style={{ flex: 2, minWidth: 0 }}>
          <VersionHistory api={api} versions={selectedVersions} />
        </div>
      </div>
    </PageShell>
  );
}

function RuleBuilder({
  draft,
  queues,
  onChange,
}: {
  draft: RuleDraft;
  queues: string[];
  onChange: (d: RuleDraft) => void;
}) {
  const trigger = draft.trigger;

  const setTriggerType = (type: string) => {
    if (type === trigger.type) return;
    onChange(
      type === 'schedule'
        ? // A sweep acts on every target its scan finds; the engine does not evaluate a condition.
          { ...draft, trigger: { type: 'schedule', cron: '0 2 * * *', scan: SCAN_PREDICATES[0] }, condition: null }
        : { ...draft, trigger: { type: 'event', event: EVENT_TYPES[0] } },
    );
  };

  const setActionKind = (kind: string) => {
    if (kind === draft.action.kind) return;
    onChange({
      ...draft,
      action:
        kind === 'cancel_tasks'
          ? { kind: 'cancel_tasks', scope: CANCEL_SCOPES[0] }
          : { kind: 'create_task', queue: queues[0] ?? 'intake', sla: '4h', template: '' },
    });
  };

  return (
    <Card>
      <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Rule builder</div>

      <div style={{ display: 'grid', gap: tokens.space(2), gridTemplateColumns: '1fr 1fr' }}>
        <Field label="Rule key">
          <input
            style={inputStyle}
            value={draft.ruleKey}
            onChange={(e) => onChange({ ...draft, ruleKey: e.target.value })}
            placeholder="R13"
          />
        </Field>
        <Field label="Runs">
          <select style={inputStyle} value={trigger.type} onChange={(e) => setTriggerType(e.target.value)}>
            <option value="event">when an event arrives</option>
            <option value="schedule">on a schedule</option>
          </select>
        </Field>
        {trigger.type === 'event' ? (
          <Field label="When event">
            <select
              style={inputStyle}
              value={trigger.event}
              onChange={(e) => onChange({ ...draft, trigger: { type: 'event', event: e.target.value } })}
            >
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Cron schedule">
              <input
                style={inputStyle}
                value={trigger.cron}
                placeholder="0 2 * * *"
                onChange={(e) => onChange({ ...draft, trigger: { ...trigger, cron: e.target.value } })}
              />
            </Field>
            <Field label="For each">
              <select
                style={inputStyle}
                value={trigger.scan}
                onChange={(e) => onChange({ ...draft, trigger: { ...trigger, scan: e.target.value } })}
              >
                {SCAN_PREDICATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>

      <div style={sectionTitle}>Condition</div>
      {trigger.type === 'event' ? (
        <ConditionEditor
          condition={draft.condition}
          onChange={(condition: Condition | null) => onChange({ ...draft, condition })}
        />
      ) : (
        <div style={mutedNote}>A scheduled rule acts on everything its scan finds, so it takes no condition.</div>
      )}

      <div style={sectionTitle}>Action</div>
      <div style={{ display: 'grid', gap: tokens.space(2), gridTemplateColumns: '1fr 1fr' }}>
        <Field label="Then">
          <select style={inputStyle} value={draft.action.kind} onChange={(e) => setActionKind(e.target.value)}>
            <option value="create_task">create a task</option>
            <option value="cancel_tasks">cancel open tasks</option>
          </select>
        </Field>
        {draft.action.kind === 'create_task' ? (
          <CreateTaskFields
            action={draft.action}
            queues={queues}
            onChange={(action) => onChange({ ...draft, action })}
          />
        ) : (
          <Field label="For the">
            <select
              style={inputStyle}
              value={draft.action.scope}
              onChange={(e) => onChange({ ...draft, action: { kind: 'cancel_tasks', scope: e.target.value } })}
            >
              {CANCEL_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Card>
  );
}

type CreateTaskAction = Extract<RuleDraft['action'], { kind: 'create_task' }>;

function CreateTaskFields({
  action,
  queues,
  onChange,
}: {
  action: CreateTaskAction;
  queues: string[];
  onChange: (a: CreateTaskAction) => void;
}) {
  const setPriority = (text: string) => {
    // No priority is "leave the key out", not priority 0 stored as a change in the next version's diff.
    const { priority: _dropped, ...rest } = action;
    onChange(text === '' ? rest : { ...rest, priority: Number(text) });
  };
  // A stored rule may name a queue that has since been removed; keep it selectable so it shows.
  const queueOptions = queues.includes(action.queue) ? queues : [action.queue, ...queues];

  return (
    <>
      <Field label="Queue">
        {queues.length > 0 ? (
          <select style={inputStyle} value={action.queue} onChange={(e) => onChange({ ...action, queue: e.target.value })}>
            {queueOptions.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        ) : (
          <input style={inputStyle} value={action.queue} onChange={(e) => onChange({ ...action, queue: e.target.value })} />
        )}
      </Field>
      <Field label="Task template">
        <input
          style={inputStyle}
          value={action.template}
          onChange={(e) => onChange({ ...action, template: e.target.value })}
        />
      </Field>
      <Field label="SLA">
        <input
          style={inputStyle}
          value={action.sla}
          onChange={(e) => onChange({ ...action, sla: e.target.value })}
          placeholder="4h"
        />
      </Field>
      <Field label="Priority (optional, higher first)">
        <input
          style={inputStyle}
          type="number"
          step={1}
          value={action.priority ?? ''}
          onChange={(e) => setPriority(e.target.value)}
        />
      </Field>
    </>
  );
}

/** What the rule has done lately: each trigger it looked at, and whether it matched. */
function RuleDecisions({ api, ruleKey, refreshOn }: { api: ConsoleApi; ruleKey: string; refreshOn: number }) {
  // null: not loaded, or the request failed (a key without rules:read, an older API).
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    let stale = false;
    setEntries(null);
    api
      .ruleAudit({ ruleKey, limit: 10 })
      .then((rows) => {
        if (!stale) setEntries(rows);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [api, ruleKey, refreshOn]);

  if (entries === null) return null;
  return (
    <div style={{ marginTop: tokens.space(3) }}>
      <Card>
        <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>Recent decisions</div>
        {entries.length === 0 ? (
          <div style={mutedNote}>No event has reached this rule yet.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px' }}>
            {entries.map((e) => (
              <li key={e.id} style={{ borderTop: `1px solid ${tokens.color.border}`, padding: `${tokens.space(2)} 0` }}>
                <Toolbar>
                  <Badge tone={e.matched ? 'ok' : 'neutral'}>{e.matched ? 'fired' : 'no match'}</Badge>
                  <span>
                    v{e.ruleVersion} {auditOutcome(e)}
                  </span>
                </Toolbar>
                <div style={{ ...mutedNote, marginTop: tokens.space(1) }}>
                  {auditTrigger(e)} · {new Date(e.createdAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function VersionHistory({ api, versions }: { api: ConsoleApi; versions: RuleVersion[] }) {
  if (versions.length === 0) {
    return (
      <Card>
        <EmptyState>Select a rule to see what it does and how it has changed.</EmptyState>
      </Card>
    );
  }
  const current = versions.find((v) => v.active) ?? versions[0]!;
  return (
    <>
      <Card>
        <div style={{ fontWeight: 600, marginBottom: tokens.space(2) }}>
          {current.ruleKey} v{current.version}
        </div>
        <div style={{ fontSize: '13px', lineHeight: 1.6 }}>
          <div>{describeTrigger(current.trigger)}</div>
          <div>
            <span style={{ color: tokens.color.textMuted }}>if </span>
            {describeCondition((current.condition ?? null) as Condition | null)}
          </div>
          <div>
            <span style={{ color: tokens.color.textMuted }}>then </span>
            {describeAction(current.action)}
          </div>
        </div>
      </Card>

      <div style={{ marginTop: tokens.space(3) }}>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: tokens.space(3) }}>Version history</div>
          {versions.map((v, i) => {
            const previous = versions[i + 1];
            const diffs = previous ? diffVersions(previous, v) : [];
            return (
              <div
                key={v.version}
                style={{ borderTop: `1px solid ${tokens.color.border}`, padding: tokens.space(2) }}
              >
                <Toolbar>
                  <strong>v{v.version}</strong>
                  {v.active ? <Badge tone="ok">active</Badge> : <Badge>superseded</Badge>}
                  <span style={{ color: tokens.color.textMuted, fontSize: '12px' }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </Toolbar>
                {previous ? (
                  diffs.length === 0 ? (
                    <div style={mutedNote}>No changes from v{previous.version}</div>
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
                  <div style={mutedNote}>initial version</div>
                )}
              </div>
            );
          })}
        </Card>
      </div>

      {/* Refetched when a version is published, so a new version's decisions appear under it. */}
      <RuleDecisions api={api} ruleKey={current.ruleKey} refreshOn={versions.length} />
    </>
  );
}
