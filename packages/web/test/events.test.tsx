import './setup';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { EventConsole } from '../src/events/EventConsole';
import { stubApi } from './stubApi';

after(cleanup);

const activeRule = {
  ruleKey: 'R2',
  version: 1,
  trigger: { type: 'event', event: 'application.submitted' },
  condition: { gt: ['payload.amount', 500000] },
  action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Senior review' },
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function clickSend(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText('Send event'));
  });
}

test('sends the sample event for the chosen type and reports it accepted', async () => {
  const { api, calls } = stubApi();
  render(<EventConsole api={api} />);

  await clickSend();

  assert.equal(calls.ingested.length, 1);
  const sent = calls.ingested[0]!;
  assert.equal(sent.type, 'application.submitted');
  assert.equal(sent.entityId, 'app-1001');
  assert.deepEqual(sent.payload, { amount: 750000 });
  assert.ok(sent.idempotencyKey.length > 0);
  await waitFor(() => assert.ok(screen.getByText('accepted')));
  cleanup();
});

test('choosing another event type loads its sample', async () => {
  const { api, calls } = stubApi();
  render(<EventConsole api={api} />);

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'document.uploaded' } });
  });
  await clickSend();

  assert.equal(calls.ingested[0]!.type, 'document.uploaded');
  assert.equal(calls.ingested[0]!.entityId, 'doc-1001');
  assert.deepEqual(calls.ingested[0]!.payload, { type: 'paystub', applicationId: 'app-1001' });
  cleanup();
});

test('sending again with the same key is reported as a duplicate; a fresh send is not', async () => {
  const { api, calls } = stubApi();
  render(<EventConsole api={api} />);

  await clickSend();
  await act(async () => {
    fireEvent.click(await waitFor(() => screen.getByText('send again (same key)')));
  });

  assert.equal(calls.ingested.length, 2);
  assert.equal(calls.ingested[1]!.idempotencyKey, calls.ingested[0]!.idempotencyKey);
  await waitFor(() => assert.ok(screen.getByText('duplicate')));

  // The form itself always mints a new key: sending it twice is two events.
  await clickSend();
  assert.notEqual(calls.ingested[2]!.idempotencyKey, calls.ingested[0]!.idempotencyKey);
  cleanup();
});

test('invalid JSON in the payload blocks sending and says why', async () => {
  const { api, calls } = stubApi();
  render(<EventConsole api={api} />);

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Payload (JSON)'), { target: { value: '{amount: 1' } });
  });
  assert.ok(screen.getByText('Payload is not valid JSON'));
  await clickSend();
  assert.equal(calls.ingested.length, 0);
  cleanup();
});

test('a key that may not ingest gets a plain explanation', async () => {
  const { api } = stubApi({ ingestError: { status: 403, message: 'ingest failed: forbidden' } });
  render(<EventConsole api={api} />);

  await clickSend();

  await waitFor(() => assert.ok(screen.getByText('failed')));
  assert.ok(screen.getByText('This key cannot send events. Use an admin or integrator key.'));
  cleanup();
});

test('shows the active rules the chosen event type triggers', async () => {
  const { api } = stubApi({ rules: [activeRule] });
  render(<EventConsole api={api} />);

  await waitFor(() => assert.ok(screen.getByText('R2')));
  assert.ok(screen.getByText('when payload.amount gt 500000'));

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'closing.scheduled' } });
  });
  assert.ok(screen.getByText('No active rule is triggered by this event, so it creates no tasks.'));
  cleanup();
});

test('a key that cannot read rules can still send; the rule hints are simply absent', async () => {
  const { api, calls } = stubApi({ rulesForbidden: true });
  render(<EventConsole api={api} />);

  await clickSend();
  assert.equal(calls.ingested.length, 1);
  assert.equal(screen.queryByText(/Rules listening for/), null);
  cleanup();
});
