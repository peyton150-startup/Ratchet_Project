import './setup';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { OperatorConsole } from '../src/operator/OperatorConsole';
import { stubApi, makeTask } from './stubApi';

after(cleanup);

test('renders tasks returned by the API', async () => {
  const { api } = stubApi({ tasks: [makeTask({ id: 'a', template: 'Verify income' })] });
  render(<OperatorConsole api={api} />);

  await waitFor(() => assert.ok(screen.getByText('Verify income')));
  cleanup();
});

test('shows only the actions legal for a task state', async () => {
  const { api } = stubApi({
    tasks: [makeTask({ id: 'open-task', state: 'open' }), makeTask({ id: 'done', state: 'completed' })],
  });
  render(<OperatorConsole api={api} />);

  // An open task offers claim; nothing offers actions once terminal.
  await waitFor(() => assert.ok(screen.getByText('claim')));
  assert.equal(screen.queryByText('complete'), null, 'complete is not offered on an open task');
  cleanup();
});

test('clicking claim calls the API and reflects the new state', async () => {
  const { api, calls } = stubApi({ tasks: [makeTask({ id: 'a', state: 'open' })] });
  render(<OperatorConsole api={api} />);

  const button = await waitFor(() => screen.getByText('claim'));
  await act(async () => {
    fireEvent.click(button);
  });

  assert.deepEqual(calls.act, [{ action: 'claim', id: 'a' }]);
  // The click also selects the row, so the new state shows in both the table and the detail panel.
  await waitFor(() => assert.ok(screen.getAllByText('claimed').length >= 1));
  cleanup();
});

test('a live subscription push updates the table', async () => {
  const { api, pushUpdate } = stubApi({ tasks: [makeTask({ id: 'a', state: 'open' })] });
  render(<OperatorConsole api={api} />);
  await waitFor(() => assert.ok(screen.getByText('open')));

  await act(async () => {
    pushUpdate(makeTask({ id: 'a', state: 'blocked' }));
  });

  await waitFor(() => assert.ok(screen.getByText('blocked')));
  cleanup();
});

test('a pushed task that is not in the list is inserted', async () => {
  const { api, pushUpdate } = stubApi({ tasks: [] });
  render(<OperatorConsole api={api} />);
  await waitFor(() => assert.ok(screen.getByText('No tasks in this queue.')));

  await act(async () => {
    pushUpdate(makeTask({ id: 'new', template: 'Fresh task' }));
  });

  await waitFor(() => assert.ok(screen.getByText('Fresh task')));
  cleanup();
});

test('the connection badge follows the socket, not the first task update', async () => {
  const { api, setConnection, pushUpdate } = stubApi({ tasks: [makeTask({ id: 'a' })] });
  render(<OperatorConsole api={api} />);
  await waitFor(() => assert.ok(screen.getByText('connecting…')));

  // A task arriving says nothing about the socket state on its own.
  await act(async () => {
    pushUpdate(makeTask({ id: 'a', state: 'claimed' }));
  });
  assert.ok(screen.getByText('connecting…'));

  await act(async () => setConnection('live'));
  assert.ok(screen.getByText('live'));
  await act(async () => setConnection('reconnecting'));
  assert.ok(screen.getByText('reconnecting…'));
  await act(async () => setConnection('offline'));
  assert.ok(screen.getByText('offline'));
  cleanup();
});

test('a failed subscription is shown on the page and can be dismissed', async () => {
  const { api, failSubscription } = stubApi({ tasks: [] });
  render(<OperatorConsole api={api} />);
  await waitFor(() => assert.ok(screen.getByText('No tasks in this queue.')));

  await act(async () => failSubscription('forbidden'));
  assert.ok(screen.getByText('forbidden'));

  await act(async () => {
    fireEvent.click(screen.getByText('dismiss'));
  });
  assert.equal(screen.queryByText('forbidden'), null);
  cleanup();
});

test('a blocked task can be unblocked, and a claimed task released', async () => {
  const { api, calls } = stubApi({ tasks: [makeTask({ id: 'b', state: 'blocked' })] });
  render(<OperatorConsole api={api} />);

  const unblock = await waitFor(() => screen.getByText('unblock'));
  await act(async () => {
    fireEvent.click(unblock);
  });
  // Unblocked means claimed again, which offers release back to the queue.
  const release = await waitFor(() => screen.getByText('release'));
  await act(async () => {
    fireEvent.click(release);
  });

  assert.deepEqual(calls.act, [
    { action: 'unblock', id: 'b' },
    { action: 'release', id: 'b' },
  ]);
  await waitFor(() => assert.ok(screen.getByText('claim')));
  cleanup();
});

test('cancel sits in the detail panel and needs a second click', async () => {
  const { api, calls } = stubApi({ tasks: [makeTask({ id: 'c', state: 'open', template: 'Verify assets' })] });
  render(<OperatorConsole api={api} />);

  const row = await waitFor(() => screen.getByText('Verify assets'));
  assert.equal(screen.queryByText('cancel task'), null, 'cancel is not offered on the row');
  await act(async () => {
    fireEvent.click(row);
  });

  await act(async () => {
    fireEvent.click(screen.getByText('cancel task'));
  });
  assert.deepEqual(calls.act, [], 'the first click only asks');

  await act(async () => {
    fireEvent.click(screen.getByText('yes, cancel it'));
  });
  assert.deepEqual(calls.act, [{ action: 'cancel', id: 'c' }]);
  // Viewing active work: the cancelled task leaves the table but stays in the detail panel.
  await waitFor(() => assert.ok(screen.getByText('No tasks in this queue.')));
  assert.ok(screen.getByText('cancelled'));
  assert.equal(screen.queryByText('cancel task'), null, 'a cancelled task cannot be cancelled again');
  cleanup();
});

test('the state filter asks the API for active work by default and one state on request', async () => {
  const { api, calls } = stubApi({ tasks: [] });
  render(<OperatorConsole api={api} />);
  await waitFor(() => assert.equal(calls.taskFilters.length, 1));
  assert.deepEqual(calls.taskFilters[0], { queue: undefined, activeOnly: true });

  await act(async () => {
    fireEvent.click(screen.getByText('Completed'));
  });
  await waitFor(() => assert.equal(calls.taskFilters.length, 2));
  assert.deepEqual(calls.taskFilters[1], { queue: undefined, state: 'completed' });
  await waitFor(() => assert.ok(screen.getByText('No completed tasks in this queue.')));
  cleanup();
});

test('shows who a task is assigned to', async () => {
  const { api } = stubApi({
    tasks: [
      makeTask({ id: 'a', assignee: 'agent-1', assigneeName: 'Ava Intake' }),
      makeTask({ id: 'b', template: 'Other' }),
    ],
  });
  render(<OperatorConsole api={api} />);
  await waitFor(() => assert.ok(screen.getByText('Ava Intake')));
  assert.ok(screen.getByText('unassigned'));
  cleanup();
});

test('an event with a payload can be expanded in the detail panel', async () => {
  const { api } = stubApi({
    tasks: [makeTask({ id: 'a', template: 'Senior review' })],
    events: [
      {
        id: 'e1',
        type: 'application.submitted',
        occurredAt: '2026-01-01T00:00:00.000Z',
        payload: { amount: 750000 },
        delta: {},
      },
    ],
  });
  render(<OperatorConsole api={api} />);
  const row = await waitFor(() => screen.getByText('Senior review'));
  await act(async () => {
    fireEvent.click(row);
  });
  await waitFor(() => assert.ok(screen.getByText(/750000/)));
  cleanup();
});
