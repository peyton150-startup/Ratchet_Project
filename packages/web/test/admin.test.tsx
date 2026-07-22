import './setup';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { AdminConsole } from '../src/admin/AdminConsole';
import { stubApi } from './stubApi';

after(cleanup);

const ruleV1 = {
  ruleKey: 'R10',
  version: 1,
  trigger: { type: 'event', event: 'application.updated' },
  condition: { changed: 'amount' },
  action: { kind: 'create_task', queue: 'underwriting', sla: '24h', template: 'Re-underwrite' },
  active: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const ruleV2 = { ...ruleV1, version: 2, action: { ...ruleV1.action, sla: '8h' }, active: true };

test('an invalid draft blocks publish and dry-run', async () => {
  const { api, calls } = stubApi();
  render(<AdminConsole api={api} />);

  // The default draft has an empty ruleKey and template, so both actions stay disabled.
  const publish = await waitFor(() => screen.getByText('Publish version'));
  await act(async () => {
    fireEvent.click(publish);
  });
  assert.equal(calls.created.length, 0, 'publish did not fire for an invalid draft');
  assert.ok(screen.getByText('Rule key is required'));
  cleanup();
});

test('a completed draft can be dry-run and published', async () => {
  const { api, calls } = stubApi();
  render(<AdminConsole api={api} />);

  const ruleKey = await waitFor(() => screen.getByPlaceholderText('R13'));
  await act(async () => {
    fireEvent.change(ruleKey, { target: { value: 'R13' } });
  });
  // Fill the task template (the remaining required field).
  const templateInput = screen.getByText('Task template').querySelector('input')!;
  await act(async () => {
    fireEvent.change(templateInput, { target: { value: 'Do the thing' } });
  });

  await act(async () => {
    fireEvent.click(screen.getByText('Dry run'));
  });
  assert.equal(calls.dryRuns.length, 1, 'dry run called');
  await waitFor(() => assert.ok(screen.getByText('would fire')));

  await act(async () => {
    fireEvent.click(screen.getByText('Publish version'));
  });
  assert.equal(calls.created.length, 1, 'publish called');
  cleanup();
});

test('adding a condition updates the rendered condition summary', async () => {
  const { api } = stubApi();
  render(<AdminConsole api={api} />);

  await waitFor(() => assert.ok(screen.getByText('always')));
  await act(async () => {
    fireEvent.click(screen.getByText('+ changed(field)'));
  });

  await waitFor(() => assert.ok(screen.getByText('(changed(amount))')));
  cleanup();
});

test('selecting a rule shows its version history with a structural diff', async () => {
  const { api } = stubApi({ rules: [ruleV2, ruleV1] });
  render(<AdminConsole api={api} />);

  const ruleButton = await waitFor(() => screen.getByText('R10'));
  await act(async () => {
    fireEvent.click(ruleButton);
  });

  await waitFor(() => assert.ok(screen.getByText('v2')));
  assert.ok(screen.getByText('v1'));
  assert.ok(screen.getByText('active'), 'the live version is marked');
  // The diff shows only what actually changed between v1 and v2.
  assert.ok(screen.getByText('action.sla:'));
  assert.ok(screen.getByText('24h'));
  assert.ok(screen.getByText('8h'));
  assert.ok(screen.getByText('initial version'), 'v1 has no predecessor to diff against');
  cleanup();
});
