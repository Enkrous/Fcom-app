import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { rateLimitDb } from '../_shared/ratelimit.ts';

const REPORT_REASONS = new Set([
  'spam',
  'harassment',
  'fake_account',
  'fake_profile',
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
  const allowed = await rateLimitDb(supabase, ip, 'reports', 5, 60 * 60_000);
  if (!allowed) return err('rate_limit_exceeded', 429);

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  const { data: caller } = await supabase
    .from('users')
    .select('id, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller) return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  let body: { targetId?: string; targetMessageId?: string; reason?: string; details?: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const targetId = String(body.targetId ?? '').trim();
  const targetMessageId = String(body.targetMessageId ?? '').trim();
  const reason = String(body.reason ?? '').trim();
  const normalizedReason = reason === 'fake_profile' ? 'fake_account' : reason;
  const details = String(body.details ?? '').trim().slice(0, 1000);

  if (!targetId) return err('targetId_required');
  if (targetId === caller.id) return err('cannot_report_self');
  if (!REPORT_REASONS.has(reason)) return err('invalid_reason');

  const { data: target } = await supabase
    .from('users')
    .select('id')
    .eq('id', targetId)
    .maybeSingle();

  if (!target) return err('target_not_found', 404);

  if (targetMessageId) {
    const { data: targetMessage, error: targetMessageErr } = await supabase
      .from('messages')
      .select('"fromId", "toId", "groupId"')
      .eq('id', targetMessageId)
      .maybeSingle();

    if (targetMessageErr) {
      console.error('report target message lookup error:', targetMessageErr);
      return err('report_failed', 500);
    }

    const isDirectMessage = targetMessage
      && !targetMessage.groupId
      && ((targetMessage.fromId === caller.id && targetMessage.toId === targetId)
        || (targetMessage.fromId === targetId && targetMessage.toId === caller.id));
    if (!isDirectMessage) return err('target_message_invalid', 400);
  }

  const { data: existingReport, error: existingErr } = await supabase
    .from('user_reports')
    .select('id')
    .eq('reporterId', caller.id)
    .eq('targetId', targetId)
    .eq('status', 'open')
    .maybeSingle();

  if (existingErr) {
    console.error('report duplicate check error:', existingErr);
    return err('report_failed', 500);
  }
  if (existingReport) return err('report_already_open', 409);

  const { data: report, error: insertErr } = await supabase
    .from('user_reports')
    .insert({
      reporterId: caller.id,
      targetId,
      ...(targetMessageId ? { targetMessageId } : {}),
      reason: normalizedReason,
      details,
      status: 'open',
    })
    .select('id, "reporterId", "targetId", "targetMessageId", reason, details, status, "createdAt"')
    .single();

  if (insertErr || !report) {
    if (insertErr?.code === '23505') return err('report_already_open', 409);
    console.error('report insert error:', insertErr);
    return err('report_failed', 500);
  }

  return ok({ report });
});
