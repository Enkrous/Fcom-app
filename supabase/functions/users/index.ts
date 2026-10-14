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

import { ok, err, corsPrelight, withErrorHandling }      from '../_shared/response.ts';
import { getServiceClient }           from '../_shared/db.ts';
import { requireAuthWithRevocation }  from '../_shared/jwt.ts';
import { isSameSchool }               from '../_shared/school.ts';
import { canRate, loadRatingContext, readAllRows, withCredo } from '../_shared/credo.ts';
import type { RatingContext } from '../_shared/credo.ts';

const PUBLIC_USER_FIELDS = 'id, "fullName", school, grade, nickname, "phoneVerified", role, status, cred, "createdAt", "avatarUrl"';

type UserRow = {
  id: string;
  school: string;
  cred: number;
  [field: string]: unknown;
};

Deno.serve(withErrorHandling(async (req: Request) => {
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
  const { data: caller, error: callerErr } = await supabase
    .from('users')
    .select('id, school, role, status, cred')
    .eq('id', myId)
    .maybeSingle();

  if (callerErr) return err('fetch_failed', 500);
  if (!caller)                     return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  const url          = new URL(req.url);
  const rateTargets  = url.searchParams.get('rateTargets') === 'true';

  // Fetch approved users and filter by normalized school key in JS.
  // We intentionally do not use `.eq('school', caller.school)` because the UI
  // collects free-form school names, so casing / extra spaces would split
  // people from the same real school into separate invisible groups.
  let approvedUsers: UserRow[];
  let pendingUsers: UserRow[];
  let context: RatingContext;
  try {
    [approvedUsers, pendingUsers, context] = await Promise.all([
      readAllRows<UserRow>((start, end) => supabase.from('users')
        .select(PUBLIC_USER_FIELDS).eq('status', 'approved').neq('id', myId)
        .order('cred', { ascending: false }).order('id').range(start, end)),
      caller.role === 'admin'
        ? readAllRows<UserRow>((start, end) => supabase.from('users')
          .select(PUBLIC_USER_FIELDS).eq('status', 'pending')
          .order('createdAt', { ascending: true }).order('id').range(start, end))
        : Promise.resolve([]),
      loadRatingContext(supabase, myId),
    ]);
  } catch (error) {
    console.error('users and rating eligibility fetch error:', error);
    return err('fetch_failed', 500);
  }

  const users = approvedUsers
    .filter((user: { id: string; school: string }) =>
      isSameSchool(user.school, caller.school) && !context.blockedPeerIds.has(user.id),
    )
    .map((user) => ({ ...withCredo(user), canRate: canRate(myId, user.id, context) }));
  const pending = caller.role === 'admin'
    ? pendingUsers.map((user) => withCredo(user))
    : [];
  const usersToRate = users.filter((user) => user.canRate.ok);

  return ok({
    users: rateTargets ? usersToRate : users,
    pending,
    usersToRate,
  });
}));
