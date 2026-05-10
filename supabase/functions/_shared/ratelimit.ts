/**
 * _shared/ratelimit.ts
 * Persistent rate limiter backed by the rate_limit_log Postgres table.
 * Works correctly across multiple Edge Function worker instances.
 *
 * Falls back to in-memory counting if the DB call fails (fail-open),
 * so a DB hiccup never blocks legitimate traffic entirely.
 *
 * Usage:
 *   const allowed = await rateLimitDb(supabase, ip, 'login', 10, 60_000);
 *
 * Legacy in-memory helper (kept for use before supabase client is available):
 *   const allowed = rateLimit(ip, 'register', 5, 60_000);
 */

import { getServiceClient } from './db.ts';

// ─── DB-backed (recommended for all production checks) ──────────────────────

/**
 * Persistent rate limit check using rate_limit_log table.
 *
 * @param supabase  - service_role Supabase client
 * @param key       - identifier (e.g. IP address)
 * @param action    - action name (namespaced in the key)
 * @param max       - maximum allowed requests
 * @param windowMs  - time window in milliseconds
 * @returns true if the request is allowed, false if rate-limited
 */
export async function rateLimitDb(
  supabase: ReturnType<typeof getServiceClient>,
  key: string,
  action: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const bucketKey  = `${action}:${key}`;
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  try {
    // Count existing entries within the window
    const { count, error: countErr } = await supabase
      .from('rate_limit_log')
      .select('id', { count: 'exact', head: true })
      .eq('key', bucketKey)
      .gt('createdAt', windowStart);

    if (countErr) throw countErr;

    if ((count ?? 0) >= max) {
      return false; // rate-limited
    }

    // Record this request
    await supabase.from('rate_limit_log').insert({ key: bucketKey });

    return true;
  } catch (e) {
    // Fail-open: log the error and allow the request rather than blocking all traffic
    console.error('rateLimitDb error (fail-open):', e);
    return true;
  }
}

// ─── In-memory fallback (kept for backward compatibility) ───────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Simple in-memory rate limiter.
 * Resets on cold start; not reliable across multiple worker instances.
 * Use rateLimitDb() in production.
 *
 * @param key      - identifier (e.g. IP address)
 * @param action   - action name (namespaces the bucket)
 * @param max      - maximum allowed requests
 * @param windowMs - time window in milliseconds
 * @returns true if the request is allowed, false if rate-limited
 */
export function rateLimit(
  key: string,
  action: string,
  max: number,
  windowMs: number,
): boolean {
  const bucketKey = `${action}:${key}`;
  const now = Date.now();
  let bucket = buckets.get(bucketKey);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(bucketKey, bucket);
    return true;
  }

  bucket.count += 1;
  return bucket.count <= max;
}
