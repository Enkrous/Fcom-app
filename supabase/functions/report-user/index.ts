import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { rateLimitDb } from '../_shared/ratelimit.ts';
import { isSameSchool } from '../_shared/school.ts';

const REPORT_REASONS = new Set([
  'spam',
  'harassment',
  'fake_account',
  'inappropriate_content',
  'other',
]);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  const allowed = await rateLimitDb(supabase, ip, 'report-user', 10, 60_000);
  if (!allowed) return err('rate_limit_exceeded', 429);

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  const { data: caller } = await supabase
    .from('users')
    .select('id, school, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller) return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  let body: { targetId?: string; reason?: string; details?: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const targetId = String(body.targetId ?? '').trim();
  const reason = String(body.reason ?? '').trim();
  const details = String(body.details ?? '').trim();

  if (!targetId) return err('targetId_required');
  if (targetId === caller.id) return err('cannot_report_self');
  if (!REPORT_REASONS.has(reason)) return err('invalid_reason');
  if (details.length > 1000) return err('details_too_long');

  const { data: target } = await supabase
    .from('users')
    .select('id, school, status')
    .eq('id', targetId)
    .maybeSingle();

  if (!target) return err('target_not_found', 404);
  if (target.status !== 'approved') return err('target_not_approved', 403);
  if (!isSameSchool(target.school, caller.school)) return err('cross_school_forbidden', 403);

  const { data: report, error: insertErr } = await supabase
    .from('user_reports')
    .insert({
      reporterId: caller.id,
      targetId,
      reason,
      details,
      status: 'open',
    })
    .select('id, "reporterId", "targetId", reason, details, status, "createdAt"')
    .single();

  if (insertErr || !report) {
    console.error('report insert error:', insertErr);
    return err('report_failed', 500);
  }

  return ok({ report });
});
