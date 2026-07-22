import { createHmac, timingSafeEqual } from 'node:crypto';

// Signature header format (Stripe-style): "t=<unix seconds>,v1=<hex hmac-sha256>".
// The signed message is `${timestamp}.${body}`, so replaying an old body fails the freshness check.
export const SIGNATURE_HEADER = 'x-ratchet-signature';

export function signBody(secret: string, body: string, timestampSec: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

function parseHeader(header: string): { t: number; v1: string } | null {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isFinite(t) || !v1) return null;
  return { t, v1 };
}

export interface VerifyOptions {
  toleranceSec?: number;
  nowMs?: number;
}

/** Verify a signature header against the body, using constant-time comparison and a freshness window. */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  opts: VerifyOptions = {},
): boolean {
  const parsed = parseHeader(header);
  if (!parsed) return false;
  const toleranceSec = opts.toleranceSec ?? 300;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - parsed.t) > toleranceSec) return false;

  const expected = createHmac('sha256', secret).update(`${parsed.t}.${body}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(parsed.v1, 'hex');
  } catch {
    return false;
  }
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
