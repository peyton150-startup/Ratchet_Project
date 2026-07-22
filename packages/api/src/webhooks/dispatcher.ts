import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db';
import { processWithRetry, type RetryPolicy, type Sleep } from '../tasks/processor';
import { signBody, SIGNATURE_HEADER } from './signing';
import { checkWebhookUrl, type Resolver } from './urlGuard';
import { metrics } from '../observability';

export interface WebhookRow {
  id: string;
  url: string;
  secret: string;
}

export interface SenderRequest {
  headers: Record<string, string>;
  body: string;
}

/** How a signed request is actually sent. Injectable so tests don't hit the network. */
export type Sender = (url: string, req: SenderRequest) => Promise<{ status: number }>;

const defaultSender: Sender = async (url, req) => {
  const res = await fetch(url, { method: 'POST', headers: req.headers, body: req.body });
  return { status: res.status };
};

async function loadWebhooks(client: PoolClient, eventType: string): Promise<WebhookRow[]> {
  const r = await client.query<WebhookRow>(
    `SELECT id, url, secret FROM webhooks WHERE active AND $1 = ANY(events)`,
    [eventType],
  );
  return r.rows;
}

/**
 * Delivers signed webhook notifications for a tenant event to every subscribed endpoint, with
 * bounded retry/backoff. Each attempt is HMAC-signed; every endpoint gets one delivery record
 * (delivered | failed). Non-2xx responses are retried; exhaustion records a failure.
 */
export class WebhookDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100 },
    private readonly sender: Sender = defaultSender,
    private readonly sleep?: Sleep,
    // Injectable so tests can exercise delivery without real DNS.
    private readonly resolver?: Resolver,
  ) {}

  async dispatch(tenantId: string, eventType: string, payload: unknown): Promise<number> {
    return withTenant(this.pool, tenantId, async (client) => {
      const webhooks = await loadWebhooks(client, eventType);
      const body = JSON.stringify({ type: eventType, data: payload });

      for (const wh of webhooks) {
        // Re-check at delivery time: DNS can be re-pointed after registration (DNS rebinding).
        const check = await checkWebhookUrl(wh.url, this.resolver);
        if (!check.ok) {
          metrics.webhookDeliveries.inc({ status: 'blocked' });
          await client.query(
            `INSERT INTO webhook_deliveries
               (tenant_id, webhook_id, event_type, payload, status, attempts, response_status)
             VALUES ($1, $2, $3, $4, 'failed', 0, NULL)`,
            [tenantId, wh.id, eventType, body],
          );
          continue;
        }

        let lastStatus = 0;
        const outcome = await processWithRetry(
          this.policy,
          async () => {
            const timestamp = Math.floor(Date.now() / 1000);
            const res = await this.sender(wh.url, {
              headers: {
                'content-type': 'application/json',
                [SIGNATURE_HEADER]: signBody(wh.secret, body, timestamp),
              },
              body,
            });
            lastStatus = res.status;
            if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
            return res.status;
          },
          async () => {
            /* failure is recorded below via the outcome */
          },
          this.sleep,
        );

        metrics.webhookDeliveries.inc({ status: outcome.status === 'ok' ? 'delivered' : 'failed' });
        await client.query(
          `INSERT INTO webhook_deliveries
             (tenant_id, webhook_id, event_type, payload, status, attempts, response_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tenantId,
            wh.id,
            eventType,
            body,
            outcome.status === 'ok' ? 'delivered' : 'failed',
            outcome.attempts,
            lastStatus || null,
          ],
        );
      }
      return webhooks.length;
    });
  }
}
