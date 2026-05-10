/**
 * Edge Function: POST /functions/v1/resend-otp
 *
 * Body: { phone }
 *
 * Business logic:
 *  1. Validate phone
 *  2. Rate-limit: max 3 OTP requests per IP+phone per 10 minutes
 *  3. Find user by phone — must exist, have a phone number, phoneVerified = false
 *  4. Invalidate all existing unexpired OTPs (set expiresAt to epoch)
 *  5. Generate a new 6-digit OTP with 5-minute TTL, attempts = 0
 *  6. Send via SMS provider; in dev mode return code as _devOtp in response
 *  7. Return { ok: true } (or { ok: true, _devOtp } in dev mode)
 */

import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient }      from '../_shared/db.ts';
import { rateLimitDb }           from '../_shared/ratelimit.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  let body: { phone: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const { phone } = body;
  if (!phone?.trim()) return err('phone_required');

  const ip      = req.headers.get('x-forwarded-for') ?? 'unknown';
  const supabase = getServiceClient();

  // ── Rate limit ─────────────────────────────────────────────────────────────
  if (!await rateLimitDb(supabase, `${ip}:${phone.trim()}`, 'resend_otp', 3, 10 * 60_000)) {
    return err('too_many_attempts', 429);
  }

  // ── Find user by phone ─────────────────────────────────────────────────────
  const { data: user } = await supabase
    .from('users')
    .select('id, phone, "phoneVerified"')
    .eq('phone', phone.trim())
    .maybeSingle();

  if (!user)             return err('user_not_found', 404);
  if (!user.phone)       return err('no_phone_on_record');
  if (user.phoneVerified) return ok({ already_verified: true });

  // ── Invalidate existing unexpired OTPs ─────────────────────────────────────
  await supabase
    .from('otp_codes')
    .update({ expiresAt: new Date(0).toISOString() })
    .eq('userId', user.id)
    .eq('used', false);

  // ── Generate and persist new OTP ──────────────────────────────────────────
  const code      = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();  // 5 minutes

  const { error: insertErr } = await supabase.from('otp_codes').insert({
    userId:    user.id,
    phone:     phone.trim(),
    code,
    expiresAt,
    used:      false,
    attempts:  0,
  });

  if (insertErr) {
    console.error('resend-otp insert error:', insertErr);
    return err('otp_create_failed', 500);
  }

  // ── Send via SMS provider ──────────────────────────────────────────────────
  const smsUrl = Deno.env.get('SMS_API_URL');
  const smsKey = Deno.env.get('SMS_API_KEY');

  if (smsUrl && smsKey) {
    try {
      await fetch(smsUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${smsKey}` },
        body:    JSON.stringify({ to: phone.trim(), text: `Ваш новый код Кредо: ${code}` }),
      });
    } catch (e) {
      console.error('SMS send failed:', e);
    }
  } else {
    console.log(`[DEV] Resent OTP for ${phone.trim()}: ${code}`);
  }

  // In dev mode return OTP in response (no SMS provider configured)
  const isDev = !smsUrl;
  return ok(isDev ? { _devOtp: code } : {});
});
