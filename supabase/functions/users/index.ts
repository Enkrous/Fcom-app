/**
 * Edge Function: GET /functions/v1/users
 *
 * Headers: Authorization: Bearer <jwt>
 * Query params (optional):
 *   ?status=pending|approved|all   (default: all)
 *   ?rateTargets=true              (only users the caller can rate)
 *
 * Returns users from the caller's school only (school isolation).
 * Caller must be 'approved'.
 *
 * Response:
 *   { ok: true, users: [...], pending: [...] }
 *     users   — approved users (excluding caller)
 *     pending — pending users (for the approval tab)
 */

import { ok, err, corsPrelight }      from '../_shared/response.ts';
import { getServiceClient }           from '../_shared/db.ts';
import { requireAuthWithRevocation }  from '../_shared/jwt.ts';
import { isSameSchool }               from '../_shared/school.ts';
import { filterBlockedPeers }         from '../_shared/blocks.ts';

const PUBLIC_USER_FIELDS = 'id, "fullName", school, grade, nickname, "phoneVerified", role, status, cred, "createdAt", "avatarUrl"';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'GET') return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }
  const myId = payload.sub;

  // Load caller
  const { data: caller } = await supabase
    .from('users')
    .select('id, school, role, status, cred')
    .eq('id', myId)
    .maybeSingle();

  if (!caller)                     return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  const url          = new URL(req.url);
  const rateTargets  = url.searchParams.get('rateTargets') === 'true';

  // Fetch approved users and filter by normalized school key in JS.
  // We intentionally do not use `.eq('school', caller.school)` because the UI
  // collects free-form school names, so casing / extra spaces would split
  // people from the same real school into separate invisible groups.
  const { data: approvedUsers, error: approvedErr } = await supabase
    .from('users')
    .select(PUBLIC_USER_FIELDS)
    .eq('status', 'approved')
    .neq('id', myId)
    .order('cred', { ascending: false });

  if (approvedErr) {
    console.error('users fetch error:', approvedErr);
    return err('fetch_failed', 500);
  }

  // Same normalized-school filtering for pending users.
  const { data: pendingUsers, error: pendingErr } = await supabase
    .from('users')
    .select(PUBLIC_USER_FIELDS)
    .eq('status', 'pending')
    .order('createdAt', { ascending: true });

  if (pendingErr) {
    console.error('pending fetch error:', pendingErr);
    return err('fetch_failed', 500);
  }

  let users = (approvedUsers ?? []).filter((user: { school: string }) =>
    isSameSchool(user.school, caller.school),
  );
  users = await filterBlockedPeers(supabase, myId, users);
  const pending = caller.role === 'admin'
    ? (pendingUsers ?? [])
    : [];

  // If rateTargets=true, filter to only users the caller can rate
  // (had conversation + no rating in last 24h)
  if (rateTargets && users.length > 0) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get partners the caller has chatted with
    const { data: sentMsgs } = await supabase
      .from('messages')
      .select('"toId"')
      .eq('fromId', myId);

    const { data: receivedMsgs } = await supabase
      .from('messages')
      .select('"fromId"')
      .eq('toId', myId);

    const chatPartnerIds = new Set<string>([
      ...(sentMsgs ?? []).map((m: { toId: string }) => m.toId),
      ...(receivedMsgs ?? []).map((m: { fromId: string }) => m.fromId),
    ]);

    // Get users already rated in last 24h
    const { data: recentRatings } = await supabase
      .from('rate_log')
      .select('"to"')
      .eq('from', myId)
      .gt('date', dayAgo);

    const recentlyRatedIds = new Set(
      (recentRatings ?? []).map((r: { to: string }) => r.to),
    );

    users = users.filter((u: { id: string }) =>
      chatPartnerIds.has(u.id) && !recentlyRatedIds.has(u.id),
    );
  }

  return ok({
    users,
    pending,
  });
});
