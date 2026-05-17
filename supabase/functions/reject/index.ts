/**
 * Edge Function: POST /functions/v1/reject
 *
 * Headers: Authorization: Bearer <jwt>
 * Body:    { userId, deviceFingerprint? }
 *
 * Business logic (mirrors credo.js rejectUser + device blocking):
 *  1. Verify JWT + session revocation check → callerId
 *  2. Load caller from DB — must have status = 'approved'
 *  3. Load target user — must exist, same school, status = 'pending'
 *  4. Cannot reject self
 *  5. Call reject_and_log(actor_id, target_id, fingerprint):
 *       – sets app.actor_id session variable (so the trigger logs the correct actor)
 *       – UPDATE users SET status = 'rejected'
 *       – trigger trg_log_status_change writes actorId correctly to approval_log
 *       – optionally inserts device fingerprint into device_blocks
 *  6. Return { ok: true, user: { id, status } }
 *
 * Access control:
 *   JWT required + session not revoked + caller.status === 'approved'
 *   + caller and target must be in the same school
 */

import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { isSameSchool }              from '../_shared/school.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();

  // ── Authenticate ──────────────────────────────────────────────────────────
  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  let body: { userId: string; deviceFingerprint?: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const { userId, deviceFingerprint = '' } = body;
  if (!userId?.trim()) return err('userId_required');

  // ── Load caller ───────────────────────────────────────────────────────────
  const { data: caller } = await supabase
    .from('users')
    .select('id, school, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller)                      return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  // ── Load target ───────────────────────────────────────────────────────────
  const { data: target } = await supabase
    .from('users')
    .select('id, school, status')
    .eq('id', userId.trim())
    .maybeSingle();

  if (!target)                          return err('user_not_found', 404);
  if (!isSameSchool(target.school, caller.school)) return err('cross_school_forbidden', 403);
  if (target.status !== 'pending')      return err('user_not_pending');
  if (target.id === caller.id)          return err('cannot_reject_self');

  // ── Atomic reject + log ───────────────────────────────────────────────────
  // reject_and_log sets app.actor_id so the trigger trg_log_status_change
  // records the correct actorId in approval_log (not the target's own ID).
  const { data: rows, error: rpcErr } = await supabase.rpc('reject_and_log', {
    p_actor_id:    caller.id,
    p_target_id:   target.id,
    p_fingerprint: deviceFingerprint?.trim() || null,
  });

  if (rpcErr || !rows?.length) {
    console.error('reject_and_log error:', rpcErr);
    return err('reject_failed', 500);
  }

  return ok({ user: { id: target.id, status: 'rejected' } });
});
