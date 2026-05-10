/**
 * Edge Function: POST /functions/v1/rate
 *
 * Headers: Authorization: Bearer <jwt>
 * Body:    { toUserId, score [, fromUserId] }  OR legacy { toId, score }
 *          score: integer 1..5
 *
 *          fromUserId — OPTIONAL.  If provided it MUST match the JWT sub claim.
 *          The authoritative fromId is ALWAYS taken from the JWT, never from the
 *          body.  A mismatch returns fromUserId_mismatch (400) so clients learn
 *          early rather than getting a confusing wrong-actor error later.
 *
 * Full business logic — exact port of credo.js rateUser():
 *
 *  Validation:
 *    - score ∈ [1..5] integer
 *    - fromId ≠ toId
 *    - Both users are 'approved' and in the same school
 *
 *  canRate checks:
 *    - had_conversation(fromId, toId) — at least one message must exist
 *    - No rate_log entry for (from, to) in the last 24 h
 *      (app-level fast rejection + DB trigger as authoritative guard)
 *
 *  Weight calculation:
 *    credWeight  = rater.cred < 5  → 0.3
 *                  rater.cred < 15 → 0.7
 *                  rater.cred ≥ 15 → 1.0
 *    repeatDecay = max(0.2, 0.8 ^ timesRated)
 *    weight      = credWeight × repeatDecay
 *
 *  Delta:
 *    SCORE_DELTA    = { 1: −2, 2: −1, 3: 0, 4: +1, 5: +2 }
 *    baseDelta      = SCORE_DELTA[score]
 *    rawDelta       = baseDelta × weight
 *    dailyUsed      = SUM(ABS(effectiveDelta)) for target in last 24h
 *    remaining      = MAX_DAILY_CHANGE (5) − dailyUsed
 *    effectiveDelta = clamp(rawDelta, −remaining .. +remaining)
 *
 *  Atomic commit (no race condition):
 *    rate_and_apply(fromId, toId, score, weight, baseDelta, effectiveDelta)
 *      ├─ INSERT INTO rate_log  ← enforce_rate_cooldown trigger fires here
 *      └─ UPDATE users SET cred = GREATEST(0, ROUND(cred + effectiveDelta, 2))
 *
 *  Response: { ok: true, entry: {...}, newCred: number }
 */

import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { rateLimitDb }               from '../_shared/ratelimit.ts';

const SCORE_DELTA: Record<number, number> = { 1: -2, 2: -1, 3: 0, 4: 1, 5: 2 };
const MAX_DAILY_CHANGE = 5;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();

  // Rate limit: 20 requests per IP per minute
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  const allowed = await rateLimitDb(supabase, ip, 'rate', 20, 60_000);
  if (!allowed) return err('rate_limit_exceeded', 429);

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  let body: { toId?: string; toUserId?: string; fromUserId?: string; score: number };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  // fromId is authoritative from the JWT — the body field is only for client clarity.
  // If fromUserId is provided and does not match the token, reject immediately so the
  // client learns it cannot act as another user.
  const fromId = payload.sub;
  if (body.fromUserId && body.fromUserId.trim() !== fromId) {
    return err('fromUserId_mismatch', 403);
  }

  // Accept both toId (legacy) and toUserId.
  const toId = (body.toUserId ?? body.toId)?.trim();
  const { score } = body;

  if (!toId)                                                return err('toId_required');
  if (!Number.isInteger(score) || score < 1 || score > 5)  return err('invalid_score');

  if (fromId === toId) return err('self');

  // Load both users
  const [{ data: rater }, { data: target }] = await Promise.all([
    supabase.from('users').select('id, school, status, cred').eq('id', fromId).maybeSingle(),
    supabase.from('users').select('id, school, status, cred').eq('id', toId).maybeSingle(),
  ]);

  if (!rater)  return err('user_not_found', 404);
  if (!target) return err('user_not_found', 404);

  if (rater.status  !== 'approved') return err('forbidden', 403);
  if (target.status !== 'approved') return err('target_not_approved', 403);
  if (rater.school  !== target.school) return err('cross_school_forbidden', 403);

  // canRate: conversation prerequisite
  const { data: convResult } = await supabase.rpc('had_conversation', {
    id1: fromId,
    id2: toId,
  });
  if (!convResult) return err('no_chat', 403);

  // canRate: 24h cooldown — fast app-level check (DB trigger is the final guard)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentRate } = await supabase
    .from('rate_log')
    .select('id')
    .eq('from', fromId)
    .eq('to', toId)
    .gt('date', dayAgo)
    .maybeSingle();

  if (recentRate) return err('24h_limit', 429);

  // ── Weight ───────────────────────────────────────────────────────────────────

  const raterCred = Number(rater.cred);
  let credWeight: number;
  if (raterCred < 5)       credWeight = 0.3;
  else if (raterCred < 15) credWeight = 0.7;
  else                     credWeight = 1.0;

  const { data: timesRatedResult } = await supabase.rpc('get_times_rated', {
    from_id: fromId,
    to_id:   toId,
  });
  const timesRated  = Number(timesRatedResult ?? 0);
  const repeatDecay = Math.max(0.2, Math.pow(0.8, timesRated));
  const weight      = parseFloat((credWeight * repeatDecay).toFixed(3));

  // ── Delta ────────────────────────────────────────────────────────────────────

  const baseDelta = SCORE_DELTA[score];
  const rawDelta  = parseFloat((baseDelta * weight).toFixed(2));

  const { data: dailyUsedResult } = await supabase.rpc('get_daily_cred_change', {
    target_id: toId,
  });
  const dailyUsed = Number(dailyUsedResult ?? 0);
  const remaining = MAX_DAILY_CHANGE - dailyUsed;

  let effectiveDelta: number;
  if (remaining <= 0) {
    effectiveDelta = 0;
  } else if (rawDelta > 0) {
    effectiveDelta = parseFloat(Math.min(rawDelta, remaining).toFixed(2));
  } else if (rawDelta < 0) {
    effectiveDelta = parseFloat(Math.max(rawDelta, -remaining).toFixed(2));
  } else {
    effectiveDelta = 0;
  }

  // ── Atomic commit: INSERT rate_log + UPDATE cred in one DB transaction ───────

  const { data: newCred, error: rpcErr } = await supabase.rpc('rate_and_apply', {
    p_from_id:         fromId,
    p_to_id:           toId,
    p_score:           score,
    p_weight:          weight,
    p_base_delta:      baseDelta,
    p_effective_delta: effectiveDelta,
  });

  if (rpcErr) {
    // The enforce_rate_cooldown trigger raises this if two concurrent requests
    // both passed the app-level 24h check but one lost the race.
    if (rpcErr.message?.includes('rate_cooldown')) return err('24h_limit', 429);
    console.error('rate_and_apply error:', rpcErr);
    return err('rate_failed', 500);
  }

  const entry = {
    from:           fromId,
    to:             toId,
    score,
    weight,
    baseDelta,
    effectiveDelta,
    date:           new Date().toISOString(),
  };

  return ok({ entry, newCred: Number(newCred) });
});
