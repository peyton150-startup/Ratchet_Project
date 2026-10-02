import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { checkWebhookUrl, type Resolver } from './urlGuard.js';

const registerSchema = z
  .object({
    url: z.string().url(),
    events: z.array(z.string().min(1)).min(1),
  })
  .strict();

const patchSchema = z.object({ active: z.boolean() }).strict();
const idSchema = z.string().uuid();

/** REST management for integrator webhooks. Guarded by webhooks:manage upstream. */
export function webhooksRouter(pool: Pool, resolver?: Resolver): Router {
  const router = Router();

  // Register a webhook. The signing secret is returned once, here, and never again.
  router.post('/', async (req, res, next) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid webhook', details: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId as string;

    // SSRF guard: refuse URLs that resolve to private/loopback/link-local addresses, so a tenant
    // cannot use our server to reach cloud metadata or internal services.
    const check = await checkWebhookUrl(parsed.data.url, resolver);
    if (!check.ok) {
      res.status(400).json({ error: 'webhook URL rejected', reason: check.reason });
      return;
    }

    const secret = randomBytes(24).toString('hex');
    try {
      const created = await withTenant(pool, tenantId, (c) =>
        c.query<{ id: string }>(
          `INSERT INTO webhooks (tenant_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenantId, parsed.data.url, secret, parsed.data.events],
        ),
      );
      res.status(201).json({ id: created.rows[0]!.id, secret, ...parsed.data });
    } catch (err) {
      next(err);
    }
  });

  // List webhooks (secrets are never returned).
  router.get('/', async (req, res, next) => {
    const tenantId = req.tenantId as string;
    try {
      const rows = await withTenant(pool, tenantId, (c) =>
        c.query<{ id: string; url: string; events: string[]; active: boolean }>(
          `SELECT id, url, events, active FROM webhooks ORDER BY created_at DESC`,
        ),
      );
      res.json(rows.rows);
    } catch (err) {
      next(err);
    }
  });

  // Pause or resume a webhook. Delivery only loads active webhooks, so pausing stops calls to an
  // endpoint without losing its registration or its signing secret.
  router.patch('/:id', async (req, res, next) => {
    const id = idSchema.safeParse(req.params['id']);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid webhook update', details: parsed.error.flatten() });
      return;
    }
    // A malformed id cannot name a webhook; say so instead of letting the uuid cast fail as a 500.
    if (!id.success) {
      res.status(404).json({ error: 'webhook not found' });
      return;
    }
    const tenantId = req.tenantId as string;
    try {
      const updated = await withTenant(pool, tenantId, (c) =>
        c.query<{ id: string; url: string; events: string[]; active: boolean }>(
          `UPDATE webhooks SET active = $2 WHERE id = $1 RETURNING id, url, events, active`,
          [id.data, parsed.data.active],
        ),
      );
      if (updated.rowCount === 0) {
        res.status(404).json({ error: 'webhook not found' });
        return;
      }
      res.json(updated.rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // Recent deliveries for one webhook, newest first: whether it was called, and what came back.
  router.get('/:id/deliveries', async (req, res, next) => {
    const id = idSchema.safeParse(req.params['id']);
    if (!id.success) {
      res.status(404).json({ error: 'webhook not found' });
      return;
    }
    const tenantId = req.tenantId as string;
    try {
      const rows = await withTenant(pool, tenantId, (c) =>
        c.query<{
          id: string;
          event_type: string;
          status: string;
          attempts: number;
          response_status: number | null;
          created_at: Date;
        }>(
          `SELECT id, event_type, status, attempts, response_status, created_at
             FROM webhook_deliveries
            WHERE webhook_id = $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [id.data],
        ),
      );
      res.json(
        rows.rows.map((r) => ({
          id: r.id,
          eventType: r.event_type,
          status: r.status,
          attempts: r.attempts,
          responseStatus: r.response_status,
          createdAt: r.created_at,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
