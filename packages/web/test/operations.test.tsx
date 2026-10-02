import './setup';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { OperationsConsole } from '../src/ops/OperationsConsole';
import { OperatorConsole } from '../src/operator/OperatorConsole';
import { AdminConsole } from '../src/admin/AdminConsole';
import { stubApi, makeTask } from './stubApi';
import type { AuditEntry } from '../src/lib/api';

after(cleanup);

const ava = { id: 'a1', name: 'Ava Intake', skills: [], capacity: 8, load: 2, active: true, queues: ['intake', 'processing'] };
const ben = { id: 'a2', name: 'Ben Verifier', skills: ['verification'], capacity: 6, load: 6, active: true, queues: ['verification'] };

const audit = (overrides: Partial<AuditEntry>): AuditEntry => ({
  id: 'x',
  ruleKey: 'R1',
  ruleVersion: 1,
  triggerType: 'event',
  eventId: 'evt-1',
  eventType: 'application.submitted',
  entityId: 'app-1001',
  matched: true,
  decision: { action: { kind: 'create_task', template: 'Initial completeness check', queue: 'intake' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('shows queues with what is waiting, how they route, and who serves them', async () => {
  const { api } = stubApi({
    agents: [ava, ben],
    queueInfo: [
      { name: 'intake', strategy: 'round_robin', requiredSkill: null, active: true, activeTasks: 3 },
      { name: 'verification', strategy: 'skill_tag', requiredSkill: 'verification', active: true, activeTasks: 0 },
      { name: 'closing', strategy: 'capacity', requiredSkill: null, active: true, activeTasks: 1 },
    ],
  });
  render(<OperationsConsole api={api} />);

  await waitFor(() => assert.ok(screen.getByText('each agent in turn')));
  assert.ok(screen.getByText('agents with the verification skill, in turn'));
  // A queue nobody is a member of says so: tasks sent there are never assigned.
  assert.ok(screen.getByText('nobody'));
  cleanup();
});

test('shows each agent load against capacity', async () => {
  const { api } = stubApi({ agents: [ava, ben] });
  render(<OperationsConsole api={api} />);

  await waitFor(() => assert.ok(screen.getByText('2 of 8')));
  assert.ok(screen.getByText('6 of 6'));
  cleanup();
});

test('lists dead letters with the error, and says so when there are none', async () => {
  const empty = stubApi();
  render(<OperationsConsole api={empty.api} />);
  await waitFor(() => assert.ok(screen.getByText('None. Nothing has failed for good.')));
  cleanup();

  const { api } = stubApi({
    deadLetters: [
      {
        id: 'd1',
        source: 'pipeline',
        reference: 'evt-9',
        error: 'unknown state predicate: made_up',
        attempts: 3,
        payload: { eventId: 'evt-9' },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  render(<OperationsConsole api={api} />);
  await waitFor(() => assert.ok(screen.getByText('unknown state predicate: made_up')));
  assert.ok(screen.getByText(/pipeline · evt-9 · 3 attempts/));
  cleanup();
});

test('a key that cannot read dead letters still sees the team', async () => {
  const { api } = stubApi({ agents: [ava], deadLettersForbidden: true });
  render(<OperationsConsole api={api} />);

  await waitFor(() => assert.ok(screen.getByText('Ava Intake')));
  assert.ok(screen.getByText('forbidden'));
  cleanup();
});

test('Refresh reads the snapshot again', async () => {
  const { api, calls } = stubApi({ agents: [ava] });
  render(<OperationsConsole api={api} />);
  await waitFor(() => assert.equal(calls.teamReads, 1));

  await act(async () => {
    fireEvent.click(screen.getByText('Refresh'));
  });
  assert.equal(calls.teamReads, 2);
  cleanup();
});

test('the task detail explains why the task exists', async () => {
  const { api, calls } = stubApi({
    tasks: [makeTask({ id: 't-9', template: 'Senior review', ruleKey: 'R2', ruleVersion: 2 })],
    audit: [
      audit({ id: 'a', ruleKey: 'R1' }),
      audit({
        id: 'b',
        ruleKey: 'R2',
        ruleVersion: 2,
        decision: { action: { kind: 'create_task', template: 'Senior review', queue: 'underwriting' } },
      }),
      audit({ id: 'c', ruleKey: 'R7', matched: false, decision: null }),
    ],
  });
  render(<OperatorConsole api={api} />);

  const row = await waitFor(() => screen.getByText('Senior review'));
  await act(async () => {
    fireEvent.click(row);
  });

  await waitFor(() => assert.ok(screen.getByText('Created by R2 v2 from application.submitted · app-1001.')));
  assert.deepEqual(calls.auditFilters, [{ taskId: 't-9' }]);
  assert.ok(screen.getByText('created "Senior review" in underwriting'));
  // The rules that looked at the same event and declined are listed too.
  assert.ok(screen.getByText('did not match'));
  cleanup();
});

test('a task with no recorded evaluations still names its rule', async () => {
  const { api } = stubApi({ tasks: [makeTask({ id: 't-1', template: 'Request updated document', ruleKey: 'R11' })] });
  render(<OperatorConsole api={api} />);

  const row = await waitFor(() => screen.getByText('Request updated document'));
  await act(async () => {
    fireEvent.click(row);
  });
  await waitFor(() => assert.ok(screen.getByText('Created by R11 v1.')));
  cleanup();
});

test('a selected rule shows its recent decisions', async () => {
  const rule = {
    ruleKey: 'R2',
    version: 1,
    trigger: { type: 'event', event: 'application.submitted' },
    condition: { gt: ['payload.amount', 500000] },
    action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Senior review' },
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const { api, calls } = stubApi({
    rules: [rule],
    audit: [
      audit({ id: 'a', ruleKey: 'R2', matched: false, decision: null, entityId: 'app-1002' }),
      audit({ id: 'b', ruleKey: 'R1' }),
    ],
  });
  render(<AdminConsole api={api} />);

  const button = await waitFor(() => screen.getByText('R2'));
  await act(async () => {
    fireEvent.click(button);
  });

  await waitFor(() => assert.ok(screen.getByText('Recent decisions')));
  assert.deepEqual(calls.auditFilters, [{ ruleKey: 'R2', limit: 10 }]);
  assert.ok(screen.getByText('no match'));
  assert.ok(screen.getByText(/application\.submitted · app-1002/));
  cleanup();
});
