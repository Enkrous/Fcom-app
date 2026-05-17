import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

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

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, "fullName", school, grade, nickname, phone, "phoneVerified", role, status, cred, "createdAt", "avatarUrl"')
    .eq('id', payload.sub)
    .maybeSingle();

  if (userErr) {
    console.error('me fetch error:', userErr);
    return err('fetch_failed', 500);
  }
  if (!user) return err('user_not_found', 404);

  return ok({
    user,
    canApprove: user.status === 'approved' && user.role === 'admin',
  });
});
