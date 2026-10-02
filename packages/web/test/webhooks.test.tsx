import './setup';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { WebhooksConsole } from '../src/webhooks/WebhooksConsole';
import { stubApi } from './stubApi';

after(cleanup);

const hook = { id: 'wh-a', url: 'https://example.com/hook', events: ['task.created'], active: true };

const click = async (text: string): Promise<void> => {
  const target = await waitFor(() => screen.getByText(text));
  await act(async () => {
    fireEvent.click(target);
  });
};

test('registering shows the signing secret once and lists the new endpoint', async () => {
  const { api, calls } = stubApi();
  render(<WebhooksConsole api={api} />);
  await waitFor(() => assert.ok(screen.getByText('No webhooks registered.')));

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: ' https://example.com/hook ' } });
  });
  await click('Register webhook');

  assert.deepEqual(calls.registered, [{ url: 'https://example.com/hook', events: ['task.created'] }]);
  await waitFor(() => assert.ok(screen.getByText('whsec_test')));
  assert.ok(screen.getByText('https://example.com/hook'), 'the endpoint is listed');

  // Dismissing the secret removes it for good; nothing on the page can bring it back.
  await click('I have copied it');
  assert.equal(screen.queryByText('whsec_test'), null);
  cleanup();
});

test('a URL is required before registering', async () => {
  const { api, calls } = stubApi();
  render(<WebhooksConsole api={api} />);

  await click('Register webhook');
  assert.equal(calls.registered.length, 0);
  cleanup();
});

test('a refused URL shows the reason the API gave', async () => {
  const { api } = stubApi({
    registerError: { status: 400, message: 'registerWebhook failed: webhook URL rejected: resolves to a private address' },
  });
  render(<WebhooksConsole api={api} />);

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: 'http://10.0.0.1/hook' } });
  });
  await click('Register webhook');

  await waitFor(() => assert.ok(screen.getByText(/resolves to a private address/)));
  cleanup();
});

test('an endpoint can be paused and resumed', async () => {
  const { api, calls } = stubApi({ webhooks: [hook] });
  render(<WebhooksConsole api={api} />);

  await click('pause');
  assert.deepEqual(calls.setActive, [{ id: 'wh-a', active: false }]);
  await waitFor(() => assert.ok(screen.getByText('paused')));

  await click('resume');
  assert.deepEqual(calls.setActive[1], { id: 'wh-a', active: true });
  await waitFor(() => assert.ok(screen.getByText('active')));
  cleanup();
});

test('the delivery log shows what was sent and what came back', async () => {
  const { api } = stubApi({
    webhooks: [hook],
    deliveries: {
      'wh-a': [
        { id: 'd2', eventType: 'task.created', status: 'failed', attempts: 3, responseStatus: 500, createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'd1', eventType: 'task.created', status: 'delivered', attempts: 1, responseStatus: 200, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    },
  });
  render(<WebhooksConsole api={api} />);

  await click('show deliveries');
  await waitFor(() => assert.ok(screen.getByText('failed')));
  assert.ok(screen.getByText('delivered'));
  assert.ok(screen.getByText(/HTTP 500 · 3 attempts/));
  assert.ok(screen.getByText(/HTTP 200 · 1 attempt ·/));

  await click('hide deliveries');
  assert.equal(screen.queryByText('failed'), null);
  cleanup();
});

test('an endpoint with no deliveries says so', async () => {
  const { api } = stubApi({ webhooks: [hook] });
  render(<WebhooksConsole api={api} />);

  await click('show deliveries');
  await waitFor(() => assert.ok(screen.getByText('Nothing has been sent to this endpoint yet.')));
  cleanup();
});
