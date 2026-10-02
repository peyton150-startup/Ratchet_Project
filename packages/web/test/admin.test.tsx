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
    fireEvent.click(screen.getByText('+ field changed'));
  });

  await waitFor(() => assert.ok(screen.getByText('changed(amount)')));
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

// Waits for the target first: rules and queues arrive after the first render.
const click = async (text: string): Promise<void> => {
  const target = await waitFor(() => screen.getByText(text));
  await act(async () => {
    fireEvent.click(target);
  });
};
const change = async (label: string, value: string): Promise<void> => {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
};

test('rules are listed in numeric order', async () => {
  const keyed = (ruleKey: string) => ({ ...ruleV1, ruleKey, active: true });
  const { api } = stubApi({ rules: [keyed('R10'), keyed('R2'), keyed('R1')] });
  render(<AdminConsole api={api} />);

  await waitFor(() => assert.ok(screen.getByText('R10')));
  const listed = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => /^R\d+$/.test(t ?? ''));
  assert.deepEqual(listed, ['R1', 'R2', 'R10']);
  cleanup();
});

test('selecting a rule shows what it does and loads it for editing as the next version', async () => {
  const { api, calls } = stubApi({ rules: [ruleV2, ruleV1] });
  render(<AdminConsole api={api} />);

  await click('R10');

  // Its definition, in words.
  await waitFor(() => assert.ok(screen.getByText('when application.updated')));
  assert.ok(screen.getByText('create "Re-underwrite" in underwriting, SLA 8h'));
  // The builder now holds the active version, so publishing is an edit, not a retype.
  assert.equal((screen.getByPlaceholderText('R13') as HTMLInputElement).value, 'R10');
  assert.equal((screen.getByLabelText('Changed field') as HTMLInputElement).value, 'amount');
  assert.ok(screen.getByText(/Publishing creates R10 v3 and supersedes v2\./));

  await change('SLA', '2h');
  await click('Publish version');
  assert.deepEqual(calls.created, [
    { ruleKey: 'R10', trigger: ruleV2.trigger, condition: ruleV2.condition, action: { ...ruleV2.action, sla: '2h' } },
  ]);
  await waitFor(() => assert.ok(screen.getByText('Published R10 v3.')));
  cleanup();
});

test('New rule clears a loaded rule out of the builder', async () => {
  const { api } = stubApi({ rules: [ruleV2, ruleV1] });
  render(<AdminConsole api={api} />);

  await click('R10');
  await click('+ New rule');

  assert.equal((screen.getByPlaceholderText('R13') as HTMLInputElement).value, '');
  assert.ok(screen.getByText('always'));
  cleanup();
});

test('a comparison can be edited: reference, operator and value', async () => {
  const { api, calls } = stubApi();
  render(<AdminConsole api={api} />);
  await waitFor(() => screen.getByText('always'));

  await click('+ comparison');
  await change('Reference', 'payload.type');
  await change('Operator', 'in');
  await change('Value', '["paystub","W2"]');

  assert.ok(screen.getByText('payload.type in ["paystub","W2"]'));

  await change('Rule key', 'R13');
  await change('Task template', 'Verify income');
  await click('Publish version');
  assert.deepEqual((calls.created[0] as { condition: unknown }).condition, {
    in: ['payload.type', ['paystub', 'W2']],
  });
  cleanup();
});

test('adding a second condition groups them, and the group can be switched to ANY', async () => {
  const { api } = stubApi();
  render(<AdminConsole api={api} />);
  await waitFor(() => screen.getByText('always'));

  await click('+ field changed');
  await click('+ state check');
  assert.ok(screen.getByText('(changed(amount) AND state.all_required_docs_verified)'));

  await change('Group type', 'or');
  assert.ok(screen.getByText('(changed(amount) OR state.all_required_docs_verified)'));
  cleanup();
});

test('a condition the engine would reject blocks publishing and says why', async () => {
  const { api, calls } = stubApi();
  render(<AdminConsole api={api} />);
  await waitFor(() => screen.getByText('always'));

  await change('Rule key', 'R13');
  await change('Task template', 'Check');
  await click('+ comparison');
  await change('Reference', 'amount');

  assert.ok(screen.getByText(/must start with event\., payload\., delta\., state\./));
  await click('Publish version');
  assert.equal(calls.created.length, 0);
  cleanup();
});

test('dry run sends the sample payload for the rule\'s event type', async () => {
  const { api, calls } = stubApi();
  render(<AdminConsole api={api} />);
  await waitFor(() => screen.getByText('always'));

  await change('Rule key', 'R13');
  await change('Task template', 'Check');
  await change('When event', 'document.uploaded');
  await click('Dry run');

  const event = calls.dryRunEvents[0] as { type: string; entityType: string; payload: unknown };
  assert.equal(event.type, 'document.uploaded');
  assert.equal(event.entityType, 'Document');
  assert.deepEqual(event.payload, { type: 'paystub', applicationId: 'app-1001' });

  // The sample is editable, and a broken one blocks the dry run rather than sending nonsense.
  await change('Sample payload (JSON)', '{"type": ');
  assert.ok(screen.getByText('Sample payload is not valid JSON'));
  await click('Dry run');
  assert.equal(calls.dryRunEvents.length, 1);
  cleanup();
});

test('a scheduled rule takes a cron and a scan, no condition, and cannot be dry-run', async () => {
  const { api, calls } = stubApi();
  render(<AdminConsole api={api} />);
  await waitFor(() => screen.getByText('always'));

  await click('+ field changed');
  await change('Rule key', 'R14');
  await change('Task template', 'Request updated document');
  await change('Runs', 'schedule');

  assert.equal(screen.queryByText('+ comparison'), null, 'no condition editor for a sweep');
  await click('Dry run');
  assert.equal(calls.dryRuns.length, 0);

  await click('Publish version');
  const created = calls.created[0] as { trigger: unknown; condition: unknown };
  assert.deepEqual(created.trigger, { type: 'schedule', cron: '0 2 * * *', scan: 'stale_documents_at_underwriting' });
  assert.equal(created.condition, null, 'the condition added before switching is dropped');
  cleanup();
});

test('a cancel rule and a task priority can be authored', async () => {
  const { api, calls } = stubApi();
  render(<AdminConsole api={api} />);
  await waitFor(() => screen.getByText('always'));

  await change('Rule key', 'R15');
  await change('Task template', 'Senior review');
  await change('Priority (optional, higher first)', '5');
  await click('Publish version');
  assert.equal((calls.created[0] as { action: { priority?: number } }).action.priority, 5);

  // Clearing priority removes the key rather than storing 0.
  await change('Priority (optional, higher first)', '');
  await click('Publish version');
  assert.equal('priority' in (calls.created[1] as { action: object }).action, false);

  await change('Then', 'cancel_tasks');
  await click('Publish version');
  assert.deepEqual((calls.created[2] as { action: unknown }).action, { kind: 'cancel_tasks', scope: 'application' });
  cleanup();
});
