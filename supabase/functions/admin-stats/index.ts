import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

type UserRow = {
  id: string;
  nickname: string | null;
  fullName: string | null;
  school: string | null;
  role: string | null;
  status: string | null;
  createdAt: string | null;
  avatarUrl?: string | null;
};

type MessageRow = {
  time: string | null;
  type: string | null;
  groupId: string | null;
};

type GroupRow = {
  id: string;
  name: string;
  school: string | null;
  type: string | null;
  createdAt: string | null;
  avatarUrl?: string | null;
};

type GroupMemberRow = {
  groupId: string;
  role: string | null;
};

type ReportRow = {
  status: string | null;
  createdAt: string | null;
};

type BlockRow = {
  createdAt: string | null;
};

function buildDailyBuckets(days: number) {
  const now = new Date();
  const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(startOfTodayUtc);
    day.setUTCDate(startOfTodayUtc.getUTCDate() - (days - index - 1));
    const key = day.toISOString().slice(0, 10);
    const label = `${String(day.getUTCDate()).padStart(2, '0')}.${String(day.getUTCMonth() + 1).padStart(2, '0')}`;
    return { key, label, count: 0 };
  });
}

function incrementBucket(buckets: Array<{ key: string; label: string; count: number }>, value: string | null | undefined) {
  if (!value) return;
  const key = new Date(value).toISOString().slice(0, 10);
  const bucket = buckets.find((item) => item.key === key);
  if (bucket) bucket.count += 1;
}

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

  const { data: caller } = await supabase
    .from('users')
    .select('id, role, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller) return err('caller_not_found', 404);
  if (caller.role !== 'admin') return err('admin_only', 403);
  if (caller.status !== 'approved') return err('forbidden', 403);

  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const since24hMs = nowMs - dayMs;
  const since7dMs = nowMs - dayMs * 7;

  const [
    usersRes,
    messagesRes,
    groupsRes,
    memberRowsRes,
    invitesRes,
    reportsRes,
    blocksRes,
  ] = await Promise.all([
    supabase
      .from('users')
      .select('id, nickname, "fullName", school, role, status, "createdAt", "avatarUrl"'),
    supabase
      .from('messages')
      .select('time, type, "groupId"'),
    supabase
      .from('chat_groups')
      .select('id, name, school, type, "createdAt", "avatarUrl"')
      .order('createdAt', { ascending: false }),
    supabase
      .from('group_members')
      .select('"groupId", role'),
    supabase
      .from('group_invites')
      .select('status'),
    supabase
      .from('user_reports')
      .select('status, "createdAt"'),
    supabase
      .from('user_blocks')
      .select('"createdAt"'),
  ]);

  const errors = [
    usersRes.error,
    messagesRes.error,
    groupsRes.error,
    memberRowsRes.error,
    invitesRes.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    console.error('admin stats fetch error:', errors[0]);
    return err('fetch_failed', 500);
  }

  const users = (usersRes.data ?? []) as UserRow[];
  const messages = (messagesRes.data ?? []) as MessageRow[];
  const groups = (groupsRes.data ?? []) as GroupRow[];
  const members = (memberRowsRes.data ?? []) as GroupMemberRow[];
  const invites = invitesRes.data ?? [];
  if (reportsRes.error) console.warn('admin stats reports skipped:', reportsRes.error);
  if (blocksRes.error) console.warn('admin stats blocks skipped:', blocksRes.error);
  const reports = (reportsRes.error ? [] : (reportsRes.data ?? [])) as ReportRow[];
  const blocks = (blocksRes.error ? [] : (blocksRes.data ?? [])) as BlockRow[];

  const approvedUsers = users.filter((user) => user.status === 'approved').length;
  const pendingUsers = users.filter((user) => user.status === 'pending').length;
  const rejectedUsers = users.filter((user) => user.status === 'rejected').length;
  const adminUsers = users.filter((user) => user.role === 'admin').length;
  const newUsers24h = users.filter((user) => {
    const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    return createdAt >= since24hMs;
  }).length;
  const newUsers7d = users.filter((user) => {
    const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    return createdAt >= since7dMs;
  }).length;
  const newApplications24h = users.filter((user) => {
    const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    return user.status === 'pending' && createdAt >= since24hMs;
  }).length;

  const messages24h = messages.filter((message) => {
    const time = message.time ? new Date(message.time).getTime() : 0;
    return time >= since24hMs;
  }).length;
  const images24h = messages.filter((message) => {
    const time = message.time ? new Date(message.time).getTime() : 0;
    return message.type === 'image' && time >= since24hMs;
  }).length;
  const reports24h = reports.filter((report) => {
    const createdAt = report.createdAt ? new Date(report.createdAt).getTime() : 0;
    return createdAt >= since24hMs;
  }).length;

  const schoolMap = new Map<string, { school: string; totalUsers: number; approvedUsers: number; pendingUsers: number }>();
  users.forEach((row) => {
    const school = String(row.school ?? '').trim();
    if (!school) return;
    const current = schoolMap.get(school) ?? {
      school,
      totalUsers: 0,
      approvedUsers: 0,
      pendingUsers: 0,
    };
    current.totalUsers += 1;
    if (row.status === 'approved') current.approvedUsers += 1;
    if (row.status === 'pending') current.pendingUsers += 1;
    schoolMap.set(school, current);
  });

  const memberStats = new Map<string, { memberCount: number; adminCount: number }>();
  members.forEach((row) => {
    const current = memberStats.get(row.groupId) ?? { memberCount: 0, adminCount: 0 };
    current.memberCount += 1;
    if (row.role === 'admin') current.adminCount += 1;
    memberStats.set(row.groupId, current);
  });

  const messageStats = new Map<string, { messageCount: number; imageCount: number }>();
  messages.forEach((row) => {
    if (!row.groupId) return;
    const current = messageStats.get(row.groupId) ?? { messageCount: 0, imageCount: 0 };
    current.messageCount += 1;
    if (row.type === 'image') current.imageCount += 1;
    messageStats.set(row.groupId, current);
  });

  const registrationsByDay = buildDailyBuckets(7);
  const messagesByDay = buildDailyBuckets(7);

  users.forEach((user) => incrementBucket(registrationsByDay, user.createdAt));
  messages.forEach((message) => incrementBucket(messagesByDay, message.time));

  const schools = [...schoolMap.values()]
    .sort((a, b) => {
      if (b.totalUsers !== a.totalUsers) return b.totalUsers - a.totalUsers;
      return a.school.localeCompare(b.school, 'ru');
    });

  return ok({
    summary: {
      totalUsers: users.length,
      approvedUsers,
      pendingUsers,
      rejectedUsers,
      adminUsers,
      newUsers24h,
      newUsers7d,
      newApplications24h,
      totalMessages: messages.length,
      messages24h,
      images24h,
      totalGroups: groups.length,
      publicGroups: groups.filter((group) => group.type === 'school_public').length,
      privateGroups: groups.filter((group) => group.type === 'private').length,
      pendingInvites: invites.filter((invite: { status?: string | null }) => invite.status === 'pending').length,
      totalReports: reports.length,
      openReports: reports.filter((report) => report.status === 'open').length,
      reports24h,
      totalBlocks: blocks.length,
    },
    charts: {
      registrationsByDay,
      messagesByDay,
      topSchoolsByUsers: schools.slice(0, 6).map((school) => ({
        label: school.school,
        value: school.totalUsers,
        pendingUsers: school.pendingUsers,
      })),
    },
    schools: schools.slice(0, 12),
    recentUsers: [...users]
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, 12),
    groups: groups.slice(0, 20).map((group) => ({
      ...group,
      memberCount: memberStats.get(group.id)?.memberCount ?? 0,
      adminCount: memberStats.get(group.id)?.adminCount ?? 0,
      messageCount: messageStats.get(group.id)?.messageCount ?? 0,
      imageCount: messageStats.get(group.id)?.imageCount ?? 0,
    })),
  });
});
