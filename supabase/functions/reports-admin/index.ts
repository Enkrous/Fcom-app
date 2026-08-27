import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

const PUBLIC_USER_FIELDS = 'id, "fullName", school, grade, nickname, "phoneVerified", role, status, cred, "createdAt", "avatarUrl"';
const REPORT_STATUSES = new Set(['open', 'reviewed', 'dismissed', 'actioned']);
const ACTION_TO_STATUS: Record<string, string> = {
  review: 'reviewed',
  reviewed: 'reviewed',
  dismiss: 'dismissed',
  dismissed: 'dismissed',
  action: 'actioned',
  actioned: 'actioned',
};

type ReportRow = {
  id: string;
  reporterId: string;
  targetId: string;
  reason: string;
  details: string;
  status: string;
  reviewedBy?: string | null;
  createdAt: string;
  reviewedAt?: string | null;
};

type UserRow = {
  id: string;
  fullName?: string | null;
  school?: string | null;
  grade?: string | null;
  nickname?: string | null;
  phoneVerified?: boolean | null;
  role?: string | null;
  status?: string | null;
  cred?: number | null;
  createdAt?: string | null;
  avatarUrl?: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (!['GET', 'POST'].includes(req.method)) return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  const { data: caller } = await supabase
    .from('users')
    .select('id, role, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller) return err('caller_not_found', 404);
  if (caller.role !== 'admin') return err('admin_only', 403);
  if (caller.status !== 'approved') return err('forbidden', 403);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const status = String(url.searchParams.get('status') ?? 'open').trim();
    if (status !== 'all' && !REPORT_STATUSES.has(status)) return err('invalid_status');

    const result = await loadReports(supabase, status);
    if (!result.ok) return err(result.error, 500);
    return ok({
      reports: result.reports,
      summary: summarizeReports(result.rawReports),
    });
  }

  let body: { reportId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const reportId = String(body.reportId ?? '').trim();
  const action = String(body.action ?? '').trim();
  const nextStatus = ACTION_TO_STATUS[action];

  if (!reportId) return err('reportId_required');
  if (!nextStatus) return err('invalid_action');

  const { data: updated, error: updateErr } = await supabase
    .from('user_reports')
    .update({
      status: nextStatus,
      reviewedBy: caller.id,
      reviewedAt: new Date().toISOString(),
    })
    .eq('id', reportId)
    .select('id, "reporterId", "targetId", reason, details, status, "reviewedBy", "createdAt", "reviewedAt"')
    .maybeSingle();

  if (updateErr) {
    console.error('report update error:', updateErr);
    return err('report_update_failed', 500);
  }
  if (!updated) return err('report_not_found', 404);

  const serialized = await serializeReports(supabase, [updated as ReportRow]);
  return ok({ report: serialized[0] ?? updated });
});

async function loadReports(
  supabase: ReturnType<typeof getServiceClient>,
  status: string,
): Promise<{ ok: true; reports: Array<Record<string, unknown>>; rawReports: ReportRow[] } | { ok: false; error: string }> {
  let query = supabase
    .from('user_reports')
    .select('id, "reporterId", "targetId", reason, details, status, "reviewedBy", "createdAt", "reviewedAt"');

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data: reports, error: reportsErr } = await query
    .order('createdAt', { ascending: false })
    .limit(100);
  if (reportsErr) {
    console.error('reports fetch error:', reportsErr);
    return { ok: false, error: 'fetch_failed' };
  }

  const rawReports = (reports ?? []) as ReportRow[];
  return {
    ok: true,
    reports: await serializeReports(supabase, rawReports),
    rawReports,
  };
}

async function serializeReports(
  supabase: ReturnType<typeof getServiceClient>,
  reports: ReportRow[],
) {
  const userIds = [...new Set(reports.flatMap((report) => [
    report.reporterId,
    report.targetId,
    report.reviewedBy,
  ]).filter(Boolean) as string[])];

  const { data: users, error: usersErr } = userIds.length
    ? await supabase
        .from('users')
        .select(PUBLIC_USER_FIELDS)
        .in('id', userIds)
    : { data: [], error: null };

  if (usersErr) {
    console.error('report users fetch error:', usersErr);
    return reports.map((report) => ({
      ...report,
      reporter: null,
      target: null,
      reviewer: null,
    }));
  }

  const userMap = Object.fromEntries(((users ?? []) as UserRow[]).map((user) => [user.id, user]));
  return reports.map((report) => ({
    ...report,
    reporter: userMap[report.reporterId] ?? null,
    target: userMap[report.targetId] ?? null,
    reviewer: report.reviewedBy ? userMap[report.reviewedBy] ?? null : null,
  }));
}

function summarizeReports(reports: ReportRow[]) {
  const summary = {
    total: reports.length,
    open: 0,
    reviewed: 0,
    dismissed: 0,
    actioned: 0,
  };

  reports.forEach((report) => {
    const status = report.status;
    if (status && status !== 'total' && Object.prototype.hasOwnProperty.call(summary, status)) {
      summary[status as 'open' | 'reviewed' | 'dismissed' | 'actioned'] += 1;
    }
  });

  return summary;
}
