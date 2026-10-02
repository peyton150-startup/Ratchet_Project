import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '@workspace/sdk';
import {
  allowedActions,
  isTerminal,
  slaStatus,
  formatSlaRemaining,
  applyTaskUpdate,
  sortTasks,
  countByState,
  matchesStateFilter,
  rowActions,
  assigneeLabel,
} from './tasks';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    ruleKey: 'R1',
    ruleVersion: 1,
    queue: 'intake',
    template: 'Initial completeness check',
    priority: 0,
    state: 'open',
    assignee: null,
    assigneeName: null,
    slaDueAt: null,
    subject: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('allowedActions mirrors the API state machine', () => {
  assert.deepEqual(allowedActions('open'), ['claim', 'cancel']);
  assert.deepEqual(allowedActions('claimed'), ['complete', 'block', 'release', 'cancel']);
  assert.deepEqual(allowedActions('blocked'), ['unblock', 'cancel']);
  // Terminal states offer nothing — the console never shows an action the server would reject.
  assert.deepEqual(allowedActions('completed'), []);
  assert.deepEqual(allowedActions('cancelled'), []);
  assert.deepEqual(allowedActions('nonsense'), []);

  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('open'), false);
});

test('slaStatus classifies none / ok / due-soon / breached', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  assert.equal(slaStatus(null, now), 'none');
  assert.equal(slaStatus('2026-01-01T18:00:00.000Z', now), 'ok');
  assert.equal(slaStatus('2026-01-01T12:30:00.000Z', now), 'due-soon');
  assert.equal(slaStatus('2026-01-01T11:00:00.000Z', now), 'breached');
});

test('formatSlaRemaining renders remaining and overdue time', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  assert.equal(formatSlaRemaining(null, now), '—');
  assert.equal(formatSlaRemaining('2026-01-01T14:30:00.000Z', now), '2h 30m');
  assert.equal(formatSlaRemaining('2026-01-03T12:00:00.000Z', now), '2d 0h');
  assert.equal(formatSlaRemaining('2026-01-01T12:45:00.000Z', now), '45m');
  assert.equal(formatSlaRemaining('2026-01-01T11:00:00.000Z', now), '1h 0m overdue');
});

test('applyTaskUpdate replaces an existing task in place', () => {
  const list = [task({ id: 'a' }), task({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z' })];
  const next = applyTaskUpdate(list, task({ id: 'b', state: 'claimed', createdAt: '2026-01-02T00:00:00.000Z' }));
  assert.equal(next.length, 2, 'no duplicate row');
  assert.equal(next.find((t) => t.id === 'b')!.state, 'claimed');
});

test('applyTaskUpdate inserts an unseen task', () => {
  const next = applyTaskUpdate([task({ id: 'a' })], task({ id: 'new' }));
  assert.equal(next.length, 2);
  assert.ok(next.some((t) => t.id === 'new'));
});

test('sortTasks orders by priority desc then oldest first', () => {
  const sorted = sortTasks([
    task({ id: 'low', priority: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
    task({ id: 'high', priority: 5, createdAt: '2026-01-03T00:00:00.000Z' }),
    task({ id: 'older', priority: 0, createdAt: '2025-12-31T00:00:00.000Z' }),
  ]);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['high', 'older', 'low'],
  );
});

test('countByState tallies queue composition', () => {
  const counts = countByState([
    task({ id: '1', state: 'open' }),
    task({ id: '2', state: 'open' }),
    task({ id: '3', state: 'claimed' }),
  ]);
  assert.deepEqual(counts, { open: 2, claimed: 1 });
});

test('rowActions offers every legal action except cancel', () => {
  assert.deepEqual(rowActions('open'), ['claim']);
  assert.deepEqual(rowActions('claimed'), ['complete', 'block', 'release']);
  // A blocked task used to be a dead end: the row offered nothing.
  assert.deepEqual(rowActions('blocked'), ['unblock']);
  assert.deepEqual(rowActions('completed'), []);
});

test('matchesStateFilter: active means still workable', () => {
  assert.equal(matchesStateFilter(task({ state: 'blocked' }), 'active'), true);
  assert.equal(matchesStateFilter(task({ state: 'completed' }), 'active'), false);
  assert.equal(matchesStateFilter(task({ state: 'completed' }), 'completed'), true);
  assert.equal(matchesStateFilter(task({ state: 'open' }), 'claimed'), false);
});

test('applyTaskUpdate drops a task that no longer matches the filter', () => {
  const keep = (t: Task): boolean => matchesStateFilter(t, 'active');
  const list = [task({ id: 'a' }), task({ id: 'b' })];
  const next = applyTaskUpdate(list, task({ id: 'a', state: 'completed' }), keep);
  assert.deepEqual(next.map((t) => t.id), ['b']);
  // A pushed task that never matched is not inserted either.
  assert.equal(applyTaskUpdate(list, task({ id: 'c', state: 'cancelled' }), keep).length, 2);
});

test('assigneeLabel prefers the agent name', () => {
  assert.equal(assigneeLabel(task()), 'unassigned');
  assert.equal(assigneeLabel(task({ assignee: '5a8c8086-39c8', assigneeName: 'Ava Intake' })), 'Ava Intake');
  assert.equal(assigneeLabel(task({ assignee: '5a8c8086-39c8' })), 'agent 5a8c8086');
});
