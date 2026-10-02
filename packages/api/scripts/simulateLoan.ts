/**
 * Play the part of a client's loan software: POST the events for one loan application to the
 * ingest API, from submission to ready-to-close, so the rules and queues can be watched reacting
 * to something other than the console's Send event form.
 *
 *   RATCHET_API_KEY=<key> pnpm --filter @workspace/api simulate-loan -- --app app-5001
 *
 * RATCHET_API_URL picks the API (default http://localhost:3000). --delay is the pause between
 * events in seconds (default 3), long enough to see each task arrive in the Operator view.
 *
 * Idempotency keys are derived from the application id, so running it twice for the same --app
 * re-sends the same events and the API answers "duplicate" instead of creating more tasks. The key
 * is only ever read from the environment: it is a live credential and must not land in a file here.
 */
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Step {
  says: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
  delta?: Record<string, unknown>;
}

function steps(app: string): Step[] {
  const n = app.replace(/^app-/, '');
  return [
    {
      says: 'Customer applies for a $620,000 loan',
      type: 'application.submitted',
      entityId: app,
      payload: { amount: 620000, stage: 'application' },
    },
    {
      says: 'Customer uploads a paystub',
      type: 'document.uploaded',
      entityId: `doc-${n}-1`,
      payload: { type: 'paystub', applicationId: app },
    },
    {
      says: 'Customer uploads a bank statement',
      type: 'document.uploaded',
      entityId: `doc-${n}-2`,
      payload: { type: 'bank_statement', applicationId: app },
    },
    {
      says: 'Paystub passes verification',
      type: 'verification.completed',
      entityId: `ver-${n}-1`,
      payload: { outcome: 'pass', docType: 'paystub', applicationId: app, documentId: `doc-${n}-1` },
    },
    {
      says: 'Bank statement passes verification',
      type: 'verification.completed',
      entityId: `ver-${n}-2`,
      payload: { outcome: 'pass', docType: 'bank_statement', applicationId: app, documentId: `doc-${n}-2` },
    },
    {
      says: 'Underwriter requires proof of insurance',
      type: 'condition.created',
      entityId: `cond-${n}-1`,
      payload: { applicationId: app, description: 'Proof of insurance' },
    },
    {
      says: 'Insurance received, no conditions left',
      type: 'condition.cleared',
      entityId: `cond-${n}-1`,
      payload: { applicationId: app, openConditions: 0 },
    },
  ];
}

async function main(): Promise<void> {
  const apiKey = process.env.RATCHET_API_KEY;
  const baseUrl = (process.env.RATCHET_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const app = arg('app') ?? 'app-5001';
  const delaySeconds = Number(arg('delay') ?? 3);
  const skipVerification = process.argv.includes('--skip-verification');

  if (!apiKey) throw new Error('RATCHET_API_KEY must be set');
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) throw new Error('--delay must be a number of seconds');

  console.log(`sending to ${baseUrl} as application ${app}\n`);
  // Step numbers (and so idempotency keys) come from the full list, so skipping steps never
  // changes what a later run of the same --app considers a duplicate.
  const all = steps(app)
    .map((step, i) => ({ step, n: i + 1 }))
    .filter(({ step }) => !(skipVerification && step.type === 'verification.completed'));
  for (const [i, { step, n }] of all.entries()) {
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        idempotencyKey: `simulate-loan:${app}:${n}`,
        type: step.type,
        entityId: step.entityId,
        payload: step.payload,
        delta: step.delta ?? {},
      }),
    });
    const outcome = res.status === 201 ? 'accepted' : res.status === 200 ? 'duplicate' : `failed (${res.status})`;
    console.log(`${i + 1}/${all.length} ${step.says}`);
    console.log(`    ${step.type} · ${step.entityId} · ${JSON.stringify(step.payload)}`);
    console.log(`    -> ${outcome}${res.ok ? '' : ` ${await res.text()}`}`);
    if (!res.ok) throw new Error(`stopped at step ${i + 1}`);
    if (i < all.length - 1) await sleep(delaySeconds * 1000);
  }
  console.log('\ndone. The tasks these created are in the Operator view.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
