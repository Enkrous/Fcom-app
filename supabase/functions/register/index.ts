/**
 * Edge Function: POST /functions/v1/register
 *
 * Body: { fullName, school, grade, nickname, phone, deviceFingerprint }
 *
 * Business logic (mirrors credo.js registerUser):
 *  1. Validate required fields
 *  2. Rate-limit check (5 req / IP / minute)
 *  3. Check device_blocks — return device_blocked if fingerprint found
 *  4. Check uniqueness (case-insensitive):
 *       nickname  → nickname_taken
 *       phone     → phone_taken        (only when phone provided)
 *       fullName  → fullName_taken
 *  5. INSERT user (trigger auto_approve_first handles first-user logic)
 *  6. If phone provided, generate OTP → save to otp_codes → send SMS
 *     In dev mode (SMS_API_URL not set) the code is also returned as _devOtp
 *  7. Issue short-lived JWT so /set-password can be called immediately
 *  8. Return { ok: true, user, token, _devOtp? }
 */

import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient }      from '../_shared/db.ts';
import { signJWT }               from '../_shared/jwt.ts';
import { rateLimitDb }           from '../_shared/ratelimit.ts';
import { isSameSchool, sanitizeSchoolName } from '../_shared/school.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const ip = req.headers.get('x-forwarded-for') ?? 'unknown';

  let body: {
    fullName: string;
    school: string;
    grade: string;
    nickname: string;
    phone?: string;
    deviceFingerprint?: string;
  };

  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const { fullName, school, grade, nickname, phone = '', deviceFingerprint = '' } = body;
  const normalizedSchool = sanitizeSchoolName(school);

  // ── 1. Validate required fields ──────────────────────────────────────────
  if (!fullName?.trim()) return err('fullName_required');
  if (!normalizedSchool) return err('school_required');
  if (!grade?.trim())    return err('grade_required');
  if (!nickname?.trim()) return err('nickname_required');

  const supabase = getServiceClient();

  // ── 2. Rate limit: max 5 registrations per IP per minute ─────────────────
  if (!await rateLimitDb(supabase, ip, 'register', 5, 60_000)) {
    return err('rate_limit_exceeded', 429);
  }

  // ── 3. Check device block ─────────────────────────────────────────────────
  if (deviceFingerprint) {
    const { data: block } = await supabase
      .from('device_blocks')
      .select('id')
      .eq('fingerprint', deviceFingerprint)
      .maybeSingle();

    if (block) return err('device_blocked', 403);
  }

  // ── 4a. Nickname uniqueness (case-insensitive via LOWER unique index) ──────
  const { data: existingNick } = await supabase
    .from('users')
    .select('id')
    .ilike('nickname', nickname.trim())
    .maybeSingle();

  if (existingNick) return err('nickname_taken');

  // ── 4b. Phone uniqueness — only checked when phone is provided ────────────
  if (phone.trim()) {
    const { data: existingPhone } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone.trim())
      .maybeSingle();

    if (existingPhone) return err('phone_taken');
  }

  // ── 4c. fullName uniqueness (case-insensitive) ────────────────────────────
  const { data: existingName } = await supabase
    .from('users')
    .select('id')
    .ilike('fullName', fullName.trim())
    .maybeSingle();

  if (existingName) return err('fullName_taken');

  const { data: knownSchools, error: schoolLookupErr } = await supabase
    .from('users')
    .select('school')
    .not('school', 'is', null);

  if (schoolLookupErr) {
    console.error('register school lookup error:', schoolLookupErr);
    return err('registration_failed', 500);
  }

  const canonicalSchool =
    (knownSchools ?? []).find((row: { school: string | null }) =>
      row.school && isSameSchool(row.school, normalizedSchool),
    )?.school ?? normalizedSchool;

  // ── 5. INSERT user — trigger auto_approve_first fires automatically ────────
  const { data: user, error: insertErr } = await supabase
    .from('users')
    .insert({
      fullName:      fullName.trim(),
      school:        canonicalSchool,
      grade:         grade.trim(),
      nickname:      nickname.trim(),
      phone:         phone.trim() || null,
      phoneVerified: false,
      status:        'pending',   // trigger overrides to 'approved' for first user in school
      cred:          0,
    })
    .select('id, "fullName", school, grade, nickname, phone, "phoneVerified", status, cred, "createdAt"')
    .single();

  if (insertErr || !user) {
    // Catch race-condition unique-constraint violations from the DB indexes
    if (insertErr?.code === '23505') {
      if (insertErr.message?.includes('fullname')) return err('fullName_taken');
      if (insertErr.message?.includes('phone'))    return err('phone_taken');
      if (insertErr.message?.includes('nickname')) return err('nickname_taken');
    }
    console.error('register insert error:', insertErr);
    return err('registration_failed', 500);
  }

  // ── 6. Generate OTP when phone is provided ────────────────────────────────
  let otpCode: string | undefined;
  if (phone.trim()) {
    otpCode = await sendOtp(supabase, user.id, phone.trim());
  }

  // ── 7. Issue short-lived JWT (1 h) so the client can call /set-password ───
  const jwtSecret = Deno.env.get('JWT_SECRET');
  let token: string | undefined;
  if (jwtSecret) {
    const jti = crypto.randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60 * 60;

    token = await signJWT({ sub: user.id, jti, iat, exp }, jwtSecret);

    await supabase.from('sessions').insert({
      userId:    user.id,
      jti,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  }

  // ── 8. Build response ─────────────────────────────────────────────────────
  // In dev mode (SMS_API_URL not set) return OTP directly so it can be tested
  // without a real SMS provider. Remove _devOtp before going to production.
  const isDev = !Deno.env.get('SMS_API_URL');

  return ok({
    user,
    token,
    ...(isDev && otpCode ? { _devOtp: otpCode } : {}),
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a 6-digit OTP, persist it to otp_codes, and send via SMS.
 * Returns the plain-text code (used for the dev-mode response).
 */
async function sendOtp(
  supabase: ReturnType<typeof getServiceClient>,
  userId: string,
  phone: string,
): Promise<string> {
  const code      = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();  // 5 minutes

  await supabase.from('otp_codes').insert({
    userId,
    phone,
    code,
    expiresAt,
    used: false,
  });

  const smsUrl = Deno.env.get('SMS_API_URL');
  const smsKey = Deno.env.get('SMS_API_KEY');

  if (smsUrl && smsKey) {
    try {
      await fetch(smsUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${smsKey}` },
        body:    JSON.stringify({ to: phone, text: `Ваш код подтверждения Кредо: ${code}` }),
      });
    } catch (e) {
      console.error('SMS send failed:', e);
    }
  } else {
    // Development fallback — code is also returned in the API response as _devOtp
    console.log(`[DEV] OTP for ${phone}: ${code}`);
  }

  return code;
}
