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
  // The live indicator flips once a message has arrived.
  assert.ok(screen.getByText('live'));
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
