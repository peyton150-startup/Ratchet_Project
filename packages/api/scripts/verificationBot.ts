/**
 * An automated verifier: works the tasks a person in the verification queue would, through the same
 * API the console uses. For each open "Verify income" / "Verify assets" task it claims the task,
 * pauses (standing in for a call to a real verification service), completes it, and sends the
 * verification.completed event that the next rule waits for.
 *
 *   RATCHET_API_KEY=<key> pnpm --filter @workspace/api verification-bot -- --app app-5001
 *
 * Scope is mandatory: --app limits the bot to one application's tasks, --all lets it work every
 * task in the queue. Without one of them it refuses to start, because on a shared tenant an
 * unscoped bot would also complete other people's tasks.
 *
 * Keys. Working tasks needs tasks:work and reporting the result needs events:ingest. No single
 * non-admin role has both, so RATCHET_API_KEY (an operator or admin key) works the tasks and
 * RATCHET_EVENTS_KEY (an integrator or admin key) sends the events; the second defaults to the
 * first, so one admin key is enough to try it. Both are read from the environment only.
 *
 * RATCHET_API_URL picks the API (default http://localhost:3000). --queue, --poll and --work
 * (seconds) default to verification, 3 and 4. Stop it with Ctrl+C.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { RatchetClient, type Task } from '@workspace/sdk';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** What each task template means: the document type reported back, which R7 reads. */
const WORK: Record<string, { docType: string }> = {
  'Verify income': { docType: 'paystub' },
  'Verify assets': { docType: 'bank_statement' },
};

const stamp = () => new Date().toLocaleTimeString();
const say = (msg: string) => console.log(`${stamp()}  ${msg}`);

function need(client: RatchetClient, label: string, permission: string): Promise<void> {
  return client.viewer().then((v) => {
    if (!v.permissions.includes(permission)) {
      throw new Error(`the ${label} key is ${v.role}, which lacks ${permission}`);
    }
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.RATCHET_API_KEY;
  const eventsKey = process.env.RATCHET_EVENTS_KEY ?? apiKey;
  const baseUrl = (process.env.RATCHET_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const queue = arg('queue') ?? 'verification';
  const app = arg('app');
  const all = process.argv.includes('--all');
  const pollMs = Number(arg('poll') ?? 3) * 1000;
  const workMs = Number(arg('work') ?? 4) * 1000;

  if (!apiKey || !eventsKey) throw new Error('RATCHET_API_KEY must be set');
  if (!app && !all) throw new Error('scope required: pass --app <application id>, or --all for every task in the queue');
  if (app && all) throw new Error('--app and --all are alternatives');
  if (![pollMs, workMs].every((ms) => Number.isFinite(ms) && ms >= 0)) throw new Error('--poll and --work are seconds');

  const tasksClient = new RatchetClient({ baseUrl, apiKey });
  const eventsClient = new RatchetClient({ baseUrl, apiKey: eventsKey });
  await need(tasksClient, 'RATCHET_API_KEY', 'tasks:work');
  await need(eventsClient, 'RATCHET_EVENTS_KEY', 'events:ingest');

  say(`watching "${queue}" on ${baseUrl} for ${app ? `application ${app}` : 'every application'}. Ctrl+C to stop.`);

  const seen = new Set<string>();
  const mine = (t: Task) => !app || t.subject['applicationId'] === app;

  const handle = async (task: Task): Promise<void> => {
    const work = WORK[task.template]!;
    const applicationId = task.subject['applicationId'] as string | undefined;
    const documentId = task.subject['entityId'] as string;
    const label = `"${task.template}" for ${applicationId ?? documentId}`;

    try {
      await tasksClient.claimTask(task.id);
    } catch (e) {
      say(`skipped ${label}: could not claim it (${e instanceof Error ? e.message : e})`);
      return;
    }
    say(`claimed   ${label}`);
    await sleep(workMs);
    await tasksClient.completeTask(task.id);
    say(`completed ${label}`);

    const event = {
      idempotencyKey: `verification-bot:${task.id}`,
      type: 'verification.completed' as const,
      entityId: `ver-${documentId}`,
      payload: { outcome: 'pass', docType: work.docType, applicationId, documentId },
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await eventsClient.ingest(event);
        say(`reported  verification.completed pass for ${work.docType} (${result.duplicate ? 'duplicate' : 'accepted'})`);
        return;
      } catch (e) {
        if (attempt === 3) {
          // The task is already completed, so nothing will revisit it: print what to replay.
          say(`COULD NOT REPORT ${label}: ${e instanceof Error ? e.message : e}`);
          say(`replay this event by hand: ${JSON.stringify(event)}`);
          return;
        }
        await sleep(1000 * attempt);
      }
    }
  };

  for (;;) {
    try {
      const open = await tasksClient.tasks({ queue, state: 'open', limit: 100 });
      for (const task of open.filter(mine)) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        if (!WORK[task.template]) {
          say(`ignoring "${task.template}": the bot only knows ${Object.keys(WORK).join(' and ')}`);
          continue;
        }
        await handle(task);
      }
    } catch (e) {
      say(`poll failed, will retry: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
