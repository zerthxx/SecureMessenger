/**
 * Resolution of "which upstream hops may be believed when deriving the
 * real client IP", kept in its own side-effect-free module so it can be
 * unit-tested without importing env.ts (which validates the whole
 * environment at import time and calls process.exit on failure).
 */

/**
 * Default trusted-proxy set for a Railway deployment.
 *
 * Railway's own guidance on X-Forwarded-For is contradictory and is
 * explicitly documented as unstable: a Railway employee states the edge
 * strips XFF so the *leftmost* value is the real client, while users
 * report it being *appended* so the rightmost is, and the hop count is
 * described as "typically 1" but sometimes 2. Configuring a hop count
 * would therefore be correct under only one of those behaviours and
 * silently wrong under the other.
 *
 * A trusted-address list is correct under BOTH. `proxy-addr` (which
 * Fastify uses) walks right-to-left starting at the socket address,
 * skipping addresses that are trusted, and returns the first untrusted
 * one. So whether the edge appends the client IP or replaces the header
 * outright, the first untrusted entry is the real client — and a value
 * a client prepended itself is never reached, because the walk stops
 * before it. That is what makes this spoof-resistant rather than
 * spoof-enabling.
 *
 * Railway's internal hop addresses are in 100.0.0.0/8. Note this range
 * overlaps CGNAT space (100.64.0.0/10): that is safe here only because
 * a Railway container is reachable exclusively through the edge proxy,
 * so the socket address is never a real end-user's address. If this
 * service is ever exposed directly to the internet, this default MUST
 * be narrowed or a genuine CGNAT client could spoof its own IP.
 */
export const RAILWAY_TRUST_PROXY = '100.0.0.0/8,loopback,linklocal,uniquelocal';

/**
 * Accepted values: `false`/empty (trust nothing — correct for direct
 * exposure and local development), `true` (trust every hop — spoofable,
 * never use behind an untrusted network), a positive integer (trust
 * exactly N hops), or a comma-separated list of IPs/CIDRs/named ranges
 * (`loopback`, `linklocal`, `uniquelocal`), which is the recommended
 * form.
 */
export function resolveTrustProxy(raw: string | undefined, production: boolean): boolean | number | string {
  const value = (raw ?? (production ? RAILWAY_TRUST_PROXY : 'false')).trim();
  if (value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
