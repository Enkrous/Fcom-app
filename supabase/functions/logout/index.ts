/**
 * Edge Function: POST /functions/v1/logout
 *
 * Headers: Authorization: Bearer <jwt>
 *
 * Deletes the session row identified by the JWT's jti claim,
 * effectively revoking the token on the server side.
 *
 * Response: { ok: true }
 */

import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient }      from '../_shared/db.ts';
import { requireAuth }           from '../_shared/jwt.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  let payload;
  try {
    payload = await requireAuth(req, jwtSecret);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  const supabase = getServiceClient();

  const { error: deleteErr } = await supabase
    .from('sessions')
    .delete()
    .eq('jti', payload.jti);

  if (deleteErr) {
    console.error('logout delete session error:', deleteErr);
    return err('logout_failed', 500);
  }

  return ok();
});
