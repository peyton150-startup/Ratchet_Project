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
