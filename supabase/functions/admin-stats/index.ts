import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

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

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    usersTotalRes,
    usersApprovedRes,
    usersPendingRes,
    usersRejectedRes,
    usersAdminRes,
    messagesTotalRes,
    messages24hRes,
    images24hRes,
    groupsTotalRes,
    publicGroupsRes,
    privateGroupsRes,
    invitesPendingRes,
    recentUsersRes,
    schoolRowsRes,
    groupRowsRes,
    memberRowsRes,
    groupMessageRowsRes,
  ] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact', head: true }),
    supabase.from('users').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('users').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('users').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
    supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'admin'),
    supabase.from('messages').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('*', { count: 'exact', head: true }).gte('time', since24h),
    supabase.from('messages').select('*', { count: 'exact', head: true }).eq('type', 'image').gte('time', since24h),
    supabase.from('chat_groups').select('*', { count: 'exact', head: true }),
    supabase.from('chat_groups').select('*', { count: 'exact', head: true }).eq('type', 'school_public'),
    supabase.from('chat_groups').select('*', { count: 'exact', head: true }).eq('type', 'private'),
    supabase.from('group_invites').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase
      .from('users')
      .select('id, nickname, "fullName", school, role, status, "createdAt"')
      .order('createdAt', { ascending: false })
      .limit(12),
    supabase
      .from('users')
      .select('school, status'),
    supabase
      .from('chat_groups')
      .select('id, name, school, type, "createdAt"')
      .order('createdAt', { ascending: false })
      .limit(20),
    supabase
      .from('group_members')
      .select('"groupId", role'),
    supabase
      .from('messages')
      .select('"groupId", type')
      .not('groupId', 'is', null),
  ]);

  const errors = [
    usersTotalRes.error,
    usersApprovedRes.error,
    usersPendingRes.error,
    usersRejectedRes.error,
    usersAdminRes.error,
    messagesTotalRes.error,
    messages24hRes.error,
    images24hRes.error,
    groupsTotalRes.error,
    publicGroupsRes.error,
    privateGroupsRes.error,
    invitesPendingRes.error,
    recentUsersRes.error,
    schoolRowsRes.error,
    groupRowsRes.error,
    memberRowsRes.error,
    groupMessageRowsRes.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    console.error('admin stats fetch error:', errors[0]);
    return err('fetch_failed', 500);
  }

  const schoolMap = new Map<string, { school: string; totalUsers: number; approvedUsers: number; pendingUsers: number }>();
  (schoolRowsRes.data ?? []).forEach((row: { school: string | null; status: string | null }) => {
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
  (memberRowsRes.data ?? []).forEach((row: { groupId: string; role: string }) => {
    const current = memberStats.get(row.groupId) ?? { memberCount: 0, adminCount: 0 };
    current.memberCount += 1;
    if (row.role === 'admin') current.adminCount += 1;
    memberStats.set(row.groupId, current);
  });

  const messageStats = new Map<string, { messageCount: number; imageCount: number }>();
  (groupMessageRowsRes.data ?? []).forEach((row: { groupId: string; type: string | null }) => {
    const current = messageStats.get(row.groupId) ?? { messageCount: 0, imageCount: 0 };
    current.messageCount += 1;
    if (row.type === 'image') current.imageCount += 1;
    messageStats.set(row.groupId, current);
  });

  return ok({
    summary: {
      totalUsers: usersTotalRes.count ?? 0,
      approvedUsers: usersApprovedRes.count ?? 0,
      pendingUsers: usersPendingRes.count ?? 0,
      rejectedUsers: usersRejectedRes.count ?? 0,
      adminUsers: usersAdminRes.count ?? 0,
      totalMessages: messagesTotalRes.count ?? 0,
      messages24h: messages24hRes.count ?? 0,
      images24h: images24hRes.count ?? 0,
      totalGroups: groupsTotalRes.count ?? 0,
      publicGroups: publicGroupsRes.count ?? 0,
      privateGroups: privateGroupsRes.count ?? 0,
      pendingInvites: invitesPendingRes.count ?? 0,
    },
    schools: [...schoolMap.values()]
      .sort((a, b) => {
        if (b.totalUsers !== a.totalUsers) return b.totalUsers - a.totalUsers;
        return a.school.localeCompare(b.school, 'ru');
      })
      .slice(0, 12),
    recentUsers: recentUsersRes.data ?? [],
    groups: (groupRowsRes.data ?? []).map((group: { id: string; name: string; school: string; type: string; createdAt: string }) => ({
      ...group,
      memberCount: memberStats.get(group.id)?.memberCount ?? 0,
      adminCount: memberStats.get(group.id)?.adminCount ?? 0,
      messageCount: messageStats.get(group.id)?.messageCount ?? 0,
      imageCount: messageStats.get(group.id)?.imageCount ?? 0,
    })),
  });
});
