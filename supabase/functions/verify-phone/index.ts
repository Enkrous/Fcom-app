/**
 * Edge Function: POST /functions/v1/verify-phone
 *
 * Body: { phone, code }
 *
 * Business logic:
 *  1. Validate inputs
 *  2. Rate-limit by IP+phone: max 5 requests per 10 minutes (persistent)
 *  3. Find user by phone — must exist and phoneVerified must be false
 *  4. Find the latest valid OTP for this phone
 *     (not expired, not used, attempts < MAX_OTP_ATTEMPTS)
 *  5. Increment the attempts counter atomically (brute-force tracking)
 *  6. Compare code (constant-time)
 *     Dev mode: "000000" is accepted when SMS_API_URL is not configured
 *  7. Wrong code  → return invalid_code
 *               → if cap reached, also invalidate OTP and return too_many_attempts
 *  8. Right code  → mark OTP used, set phoneVerified = true
 *
 * Success:  { "ok": true, "userId": "uuid" }
 * Error:    { "ok": false, "error": "..." }
 */

import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient }      from '../_shared/db.ts';
import { rateLimitDb }           from '../_shared/ratelimit.ts';

const MAX_OTP_ATTEMPTS = 5; // wrong guesses before the OTP is hard-invalidated

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  let body: { phone: string; code: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const { phone, code } = body;
  if (!phone?.trim()) return err('phone_required');
  if (!code?.trim())  return err('code_required');

  const ip      = req.headers.get('x-forwarded-for') ?? 'unknown';
  const supabase = getServiceClient();

  // ── Rate limit ────────────────────────────────────────────────────────────
  // 5 attempts per IP+phone per 10 minutes (covers both wrong codes and
  // network retries from the same device)
  if (!await rateLimitDb(supabase, `${ip}:${phone.trim()}`, 'verify_phone', 5, 10 * 60_000)) {
    return err('too_many_attempts', 429);
  }

  // ── Find user by phone ────────────────────────────────────────────────────
  const { data: user } = await supabase
    .from('users')
    .select('id, phone, "phoneVerified"')
    .eq('phone', phone.trim())
    .maybeSingle();

  if (!user) return err('user_not_found', 404);
  if (user.phoneVerified) return ok({ already_verified: true });

  // ── Find latest valid OTP ─────────────────────────────────────────────────
  const now = new Date().toISOString();
  const { data: otp } = await supabase
    .from('otp_codes')
    .select('id, code, "expiresAt", used, attempts')
    .eq('phone', phone.trim())
    .eq('used', false)
    .gt('expiresAt', now)
    .lt('attempts', MAX_OTP_ATTEMPTS)
    .order('"createdAt"', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otp) return err('otp_not_found_or_expired');

  // ── Increment attempts counter ────────────────────────────────────────────
  const newAttempts = otp.attempts + 1;
  await supabase
    .from('otp_codes')
    .update({ attempts: newAttempts })
    .eq('id', otp.id);

  // ── Verify code ───────────────────────────────────────────────────────────
  // Dev mode shortcut: "000000" is accepted when no SMS provider is configured
  const isDev    = !Deno.env.get('SMS_API_URL');
  const codeOk   = (isDev && code.trim() === '000000')
                 || timingSafeEqual(otp.code, code.trim());

  if (!codeOk) {
    if (newAttempts >= MAX_OTP_ATTEMPTS) {
      // Hard-invalidate the OTP so it can no longer be used
      await supabase
        .from('otp_codes')
        .update({ used: true })
        .eq('id', otp.id);
      return err('too_many_attempts', 429);
    }
    const remaining = MAX_OTP_ATTEMPTS - newAttempts;
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_code', attemptsLeft: remaining }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── Correct code: mark OTP used ───────────────────────────────────────────
  await supabase
    .from('otp_codes')
    .update({ used: true })
    .eq('id', otp.id);

  // ── Set phoneVerified = true ──────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from('users')
    .update({ phoneVerified: true })
    .eq('id', user.id);

  if (updateErr) {
    console.error('verify-phone update error:', updateErr);
    return err('verification_failed', 500);
  }

  return ok({ userId: user.id });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Constant-time string comparison — prevents timing-based code enumeration. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
