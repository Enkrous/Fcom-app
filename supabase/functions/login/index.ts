/**
 * Edge Function: POST /functions/v1/login
 *
 * Body: { nickname, password }
 *
 * Business logic:
 *  1. Validate inputs
 *  2. Rate-limit: max 10 attempts per IP per minute
 *  3. Find user by nickname (case-insensitive)
 *  4. Verify PBKDF2-SHA256 password hash
 *     (generic error on failure to prevent user enumeration)
 *  5. Guard checks (after successful auth):
 *       status === 'approved'     → account_not_approved / account_rejected
 *       phoneVerified (if phone)  → phone_not_verified
 *  6. Generate JWT with extended payload:
 *       { sub, jti, iat, exp: +7d, nickname, status, school }
 *  7. Persist session row in sessions table (enables server-side revocation)
 *  8. Return { ok: true, token, user }
 *
 * Success:  { "ok": true, "token": "...", "user": { id, fullName, ... } }
 * Errors:   see error table in BACKEND.md
 */

import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient }      from '../_shared/db.ts';
import { signJWT }               from '../_shared/jwt.ts';
import { verifyPassword }        from '../_shared/bcrypt.ts';
import { rateLimitDb }           from '../_shared/ratelimit.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const ip = req.headers.get('x-forwarded-for') ?? 'unknown';

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  let body: { nickname: string; password: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const { nickname, password } = body;
  if (!nickname?.trim()) return err('nickname_required');
  if (!password)         return err('password_required');

  const supabase = getServiceClient();

  // ── Rate limit: max 10 attempts per IP per minute ─────────────────────────
  if (!await rateLimitDb(supabase, ip, 'login', 10, 60_000)) {
    return err('rate_limit_exceeded', 429);
  }

  // ── Find user by nickname (case-insensitive) ──────────────────────────────
  const { data: user } = await supabase
    .from('users')
    .select('id, "fullName", school, grade, nickname, phone, "phoneVerified", "passwordHash", status, cred, "createdAt"')
    .ilike('nickname', nickname.trim())
    .maybeSingle();

  // ── Verify password (generic error prevents user enumeration) ─────────────
  // Both "user not found" and "wrong password" return the same error code so
  // an attacker cannot tell whether the account exists.
  if (!user || !user.passwordHash) {
    return err('invalid_credentials', 401);
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    return err('invalid_credentials', 401);
  }

  // ── Guard: account status ──────────────────────────────────────────────────
  // These checks run AFTER password verification so the specific error code
  // is only reachable by someone who knows the correct password.
  if (user.status === 'rejected') {
    return err('account_rejected', 403);
  }
  if (user.status !== 'approved') {
    return err('account_not_approved', 403);
  }

  // ── Guard: phone verification (only if a phone is on file) ────────────────
  if (user.phone && !user.phoneVerified) {
    return err('phone_not_verified', 403);
  }

  // ── Generate JWT ──────────────────────────────────────────────────────────
  // Payload includes profile fields so protected endpoints can make quick
  // decisions (status, school cross-check) without an extra DB round-trip.
  const jti = crypto.randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 7 * 24 * 60 * 60; // 7 days

  const token = await signJWT(
    {
      sub:      user.id,
      jti,
      iat,
      exp,
      nickname: user.nickname,
      status:   user.status,
      school:   user.school,
    },
    jwtSecret,
  );

  // ── Persist session (enables /logout revocation) ──────────────────────────
  await supabase.from('sessions').insert({
    userId:    user.id,
    jti,
    expiresAt: new Date(exp * 1000).toISOString(),
  });

  // Return user without the password hash
  const { passwordHash: _omit, ...publicUser } = user;

  return ok({ token, user: publicUser });
});
