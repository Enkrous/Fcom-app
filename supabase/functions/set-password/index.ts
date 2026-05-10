/**
 * Edge Function: POST /functions/v1/set-password
 *
 * Headers: Authorization: Bearer <jwt>
 * Body:    { password }
 *
 * Business logic:
 *  1. Verify JWT → userId
 *  2. Validate password strength (min 6 chars)
 *  3. bcrypt.hash(password, 10)
 *  4. UPDATE users SET passwordHash = hash
 *  5. Return { ok: true }
 */

import { ok, err, corsPrelight }          from '../_shared/response.ts';
import { getServiceClient }               from '../_shared/db.ts';
import { requireAuthWithRevocation }      from '../_shared/jwt.ts';
import { hashPassword }                   from '../_shared/bcrypt.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  let body: { password: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const { password } = body;
  if (!password || typeof password !== 'string') return err('password_required');
  if (password.length < 6) return err('password_too_short');
  if (password.length > 128) return err('password_too_long');

  // Verify user still exists
  const { data: user } = await supabase
    .from('users')
    .select('id, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!user) return err('user_not_found', 404);

  const hash = await hashPassword(password);

  const { error: updateErr } = await supabase
    .from('users')
    .update({ passwordHash: hash })
    .eq('id', payload.sub);

  if (updateErr) {
    console.error('set-password error:', updateErr);
    return err('update_failed', 500);
  }

  return ok();
});
