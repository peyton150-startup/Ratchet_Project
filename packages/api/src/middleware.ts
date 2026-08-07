import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { log, metrics } from './observability.js';

/** Record request count + duration, and emit one structured access log per request. */
export function requestObserver() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // Use the matched route (not the raw path) so metric cardinality stays bounded.
      const route = req.route?.path ? req.baseUrl + req.route.path : req.baseUrl || req.path;
      const labels = { route, method: req.method, status: String(res.statusCode) };
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(seconds, { route, method: req.method });
      log.info('request', { ...labels, ms: Math.round(seconds * 1000), tenantId: req.tenantId });
    });
    next();
  };
}

/**
 * CORS for the consoles, which are served from a different origin than the API in production.
 *
 * Allowlisted rather than `*`: credentials travel in an Authorization header, so a wildcard would
 * let any page on the internet drive the API with a key it managed to read. An unset CORS_ORIGINS
 * disables cross-origin access entirely, which is the correct default for a same-origin dev proxy.
 */
export function allowedOrigins(originsEnv = process.env.CORS_ORIGINS): Set<string> {
  return new Set(
    (originsEnv ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
}

export function cors(originsEnv = process.env.CORS_ORIGINS) {
  const allowed = allowedOrigins(originsEnv);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin.replace(/\/$/, ''))) {
      res.setHeader('access-control-allow-origin', origin);
      // Caches must not serve one tenant origin's response to another.
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization,content-type,accept');
      res.setHeader('access-control-max-age', '86400');
    }
    // Preflight never reaches auth: it carries no Authorization header by definition.
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/**
 * Fixed-window rate limit, keyed by tenant (falling back to IP before auth runs).
 *
 * In-memory and therefore PER INSTANCE: with N API pods the effective limit is N x max. That is an
 * accepted trade for now — it needs no extra infrastructure and still bounds a single tenant's
 * burst. Moving the counter into Redis makes it global when that matters.
 */
export function rateLimit(opts: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.tenantId ?? req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      metrics.rateLimited.inc({ key: req.tenantId ? 'tenant' : 'ip' });
      res.setHeader('retry-after', Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    next();
  };
}

/**
 * Terminal error handler. Without this, Express's default handler returns an HTML stack trace,
 * leaking internals to the caller. Log the detail server-side; return a plain JSON error.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Errors raised by middleware (e.g. body-parser's 413 for an oversized payload) carry their own
  // status. Honour it, or the caller gets a misleading 500 for what is really a client error.
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? 500;
  const clientError = status >= 400 && status < 500;

  log[clientError ? 'warn' : 'error']('request error', {
    route: req.baseUrl || req.path,
    method: req.method,
    tenantId: req.tenantId,
    status,
    error: err instanceof Error ? err.message : String(err),
    // Stacks only for genuine server faults — a client error is not an internal bug.
    stack: clientError ? undefined : err instanceof Error ? err.stack : undefined,
  });

  if (res.headersSent) return;
  res.status(status).json({
    error: clientError ? (err instanceof Error ? err.message : 'bad request') : 'internal server error',
  });
};
