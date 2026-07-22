import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for tenant-supplied webhook URLs.
 *
 * Without this, a tenant can register http://169.254.169.254/... (cloud metadata) or an internal
 * address and make *our* server fetch it on their behalf. We reject non-HTTP(S) schemes and any URL
 * that resolves to a private, loopback, or link-local address — checked at registration AND again
 * before delivery, because DNS can be re-pointed after registration (DNS rebinding).
 */

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this" network
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true; // unspecified / loopback
  if (v.startsWith('fe80')) return true; // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
  // IPv4-mapped (::ffff:a.b.c.d) — apply the IPv4 rules to the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isBlockedIPv4(mapped[1]!);
  return false;
}

export function isBlockedAddress(ip: string, family: number): boolean {
  return family === 6 ? isBlockedIPv6(ip) : isBlockedIPv4(ip);
}

/** Resolver seam so tests can exercise the guard without real DNS. */
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

export async function checkWebhookUrl(raw: string, resolve: Resolver = defaultResolver): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https are allowed' };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolve(url.hostname);
  } catch {
    return { ok: false, reason: 'hostname does not resolve' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'hostname does not resolve' };

  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      return { ok: false, reason: 'URL resolves to a private or reserved address' };
    }
  }
  return { ok: true };
}
