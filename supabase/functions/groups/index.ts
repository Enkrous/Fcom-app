import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { ensureSchoolPublicGroup, getGroupAccess } from '../_shared/groups.ts';
import { isSameSchool } from '../_shared/school.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();

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
    .select('id, school, role, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller) return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  await ensureSchoolPublicGroup(supabase, caller.school, caller.id);

  if (req.method === 'GET') {
    const isFcomAdmin = caller.role === 'admin';
    const { data: membershipRows, error: membershipErr } = await supabase
      .from('group_members')
      .select('"groupId", "userId", role, "joinedAt"')
      .eq('userId', caller.id);

    if (membershipErr) {
      console.error('groups membership error:', membershipErr);
      return err('fetch_failed', 500);
    }

    const myGroupIds = (membershipRows ?? []).map((row: { groupId: string }) => row.groupId);

    let groupsQuery = supabase
      .from('chat_groups')
      .select('id, name, school, type, "createdBy", "avatarUrl", "createdAt"')
      .order('type', { ascending: true })
      .order('name', { ascending: true });

    if (!isFcomAdmin) {
      groupsQuery = groupsQuery.in('id', myGroupIds.length ? myGroupIds : ['00000000-0000-0000-0000-000000000000']);
    }

    const { data: groups, error: groupsErr } = await groupsQuery;
    if (groupsErr) {
      console.error('groups fetch error:', groupsErr);
      return err('fetch_failed', 500);
    }

    const groupIds = (groups ?? []).map((group: { id: string }) => group.id);
    const { data: allMembers, error: allMembersErr } = groupIds.length
      ? await supabase
          .from('group_members')
          .select('"groupId", "userId", role, "joinedAt"')
          .in('groupId', groupIds)
      : { data: [], error: null };

    if (allMembersErr) {
      console.error('group members fetch error:', allMembersErr);
      return err('fetch_failed', 500);
    }

    const memberUserIds = [...new Set((allMembers ?? []).map((row: { userId: string }) => row.userId))];
    const { data: memberUsers, error: memberUsersErr } = memberUserIds.length
      ? await supabase
          .from('users')
          .select('id, nickname, "fullName", school, status, "avatarUrl"')
          .in('id', memberUserIds)
      : { data: [], error: null };

    if (memberUsersErr) {
      console.error('group member users fetch error:', memberUsersErr);
      return err('fetch_failed', 500);
    }

    const userMap = Object.fromEntries((memberUsers ?? []).map((user: { id: string }) => [user.id, user]));
    const membersByGroup: Record<string, Array<Record<string, unknown>>> = {};
    (allMembers ?? []).forEach((row: { groupId: string; userId: string; role: string; joinedAt: string }) => {
      if (!membersByGroup[row.groupId]) membersByGroup[row.groupId] = [];
      membersByGroup[row.groupId].push({
        ...userMap[row.userId],
        role: row.role,
        joinedAt: row.joinedAt,
      });
    });

    const { data: invites, error: invitesErr } = await supabase
      .from('group_invites')
      .select('id, "groupId", "invitedBy", status, "createdAt"')
      .eq('invitedUserId', caller.id)
      .eq('status', 'pending')
      .order('createdAt', { ascending: false });

    if (invitesErr) {
      console.error('group invites fetch error:', invitesErr);
      return err('fetch_failed', 500);
    }

    const inviteGroupIds = [...new Set((invites ?? []).map((invite: { groupId: string }) => invite.groupId))];
    const inviteActorIds = [...new Set((invites ?? []).map((invite: { invitedBy: string }) => invite.invitedBy))];

    const inviteGroups = inviteGroupIds.length
      ? await supabase
          .from('chat_groups')
          .select('id, name, school, type')
          .in('id', inviteGroupIds)
      : { data: [], error: null };

    if (inviteGroups.error) {
      console.error('invite groups fetch error:', inviteGroups.error);
      return err('fetch_failed', 500);
    }

    const inviteActors = inviteActorIds.length
      ? await supabase
          .from('users')
          .select('id, nickname, "fullName"')
          .in('id', inviteActorIds)
      : { data: [], error: null };

    if (inviteActors.error) {
      console.error('invite actors fetch error:', inviteActors.error);
      return err('fetch_failed', 500);
    }

    const inviteGroupMap = Object.fromEntries((inviteGroups.data ?? []).map((group: { id: string }) => [group.id, group]));
    const inviteActorMap = Object.fromEntries((inviteActors.data ?? []).map((user: { id: string }) => [user.id, user]));

    const serializedGroups = (groups ?? []).map((group: Record<string, unknown>) => {
      const members = (membersByGroup[group.id as string] ?? [])
        .sort((a, b) => String(a.nickname).localeCompare(String(b.nickname), 'ru'));
      const myMembership = members.find((member) => member.id === caller.id);

      return {
        ...group,
        members,
        memberCount: members.length,
        myRole: myMembership?.role ?? (isFcomAdmin ? 'observer' : null),
        canManage: myMembership?.role === 'admin',
      };
    });

    const serializedInvites = (invites ?? []).map((invite: { id: string; groupId: string; invitedBy: string; createdAt: string }) => ({
      id: invite.id,
      createdAt: invite.createdAt,
      group: inviteGroupMap[invite.groupId] ?? null,
      invitedBy: inviteActorMap[invite.invitedBy] ?? null,
    }));

    return ok({ groups: serializedGroups, invites: serializedInvites });
  }

  if (req.method !== 'POST') return err('method_not_allowed', 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const action = String(body.action ?? '').trim();

  if (action === 'create') {
    const name = String(body.name ?? '').trim();
    const memberIds = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(String))] : [];

    if (!name) return err('name_required');
    if (name.length > 80) return err('name_too_long');

    const { data: group, error: createErr } = await supabase
      .from('chat_groups')
      .insert({
        name,
        school: caller.school,
        type: 'private',
        createdBy: caller.id,
      })
      .select('id, name, school, type, "createdBy", "avatarUrl", "createdAt"')
      .single();

    if (createErr || !group) {
      console.error('group create error:', createErr);
      return err('group_create_failed', 500);
    }

    const { error: creatorMembershipErr } = await supabase
      .from('group_members')
      .insert({
        groupId: group.id,
        userId: caller.id,
        role: 'admin',
        addedBy: caller.id,
      });

    if (creatorMembershipErr) {
      console.error('creator membership error:', creatorMembershipErr);
      return err('group_create_failed', 500);
    }

    if (memberIds.length > 0) {
      const { data: candidates, error: candidatesErr } = await supabase
        .from('users')
        .select('id, school, status')
        .in('id', memberIds);

      if (candidatesErr) {
        console.error('invite candidates error:', candidatesErr);
        return err('group_create_failed', 500);
      }

      const validInvitees = (candidates ?? []).filter((user: { id: string; school: string; status: string }) =>
        user.id !== caller.id && user.status === 'approved' && isSameSchool(user.school, caller.school),
      );

      if (validInvitees.length > 0) {
        const { error: inviteErr } = await supabase
          .from('group_invites')
          .upsert(validInvitees.map((user: { id: string }) => ({
            groupId: group.id,
            invitedUserId: user.id,
            invitedBy: caller.id,
            status: 'pending',
            respondedAt: null,
          })), { onConflict: 'groupId,invitedUserId' });

        if (inviteErr) {
          console.error('group invite error:', inviteErr);
          return err('group_create_failed', 500);
        }
      }
    }

    return ok({ group });
  }

  if (action === 'respond_invite') {
    const inviteId = String(body.inviteId ?? '').trim();
    const decision = String(body.decision ?? '').trim();

    if (!inviteId) return err('inviteId_required');
    if (!['accept', 'decline'].includes(decision)) return err('invalid_decision');

    const { data: invite, error: inviteErr } = await supabase
      .from('group_invites')
      .select('id, "groupId", "invitedUserId", status')
      .eq('id', inviteId)
      .eq('invitedUserId', caller.id)
      .maybeSingle();

    if (inviteErr) {
      console.error('invite fetch error:', inviteErr);
      return err('invite_not_found', 404);
    }
    if (!invite || invite.status !== 'pending') return err('invite_not_found', 404);

    const nextStatus = decision === 'accept' ? 'accepted' : 'declined';
    const { error: updateInviteErr } = await supabase
      .from('group_invites')
      .update({
        status: nextStatus,
        respondedAt: new Date().toISOString(),
      })
      .eq('id', invite.id);

    if (updateInviteErr) {
      console.error('invite update error:', updateInviteErr);
      return err('invite_update_failed', 500);
    }

    if (decision === 'accept') {
      const { error: memberErr } = await supabase
        .from('group_members')
        .upsert({
          groupId: invite.groupId,
          userId: caller.id,
          role: 'member',
          addedBy: caller.id,
        }, { onConflict: 'groupId,userId' });

      if (memberErr) {
        console.error('group accept membership error:', memberErr);
        return err('invite_update_failed', 500);
      }
    }

    return ok({ inviteId: invite.id, decision });
  }

  if (action === 'leave') {
    const groupId = String(body.groupId ?? '').trim();
    if (!groupId) return err('groupId_required');

    const access = await getGroupAccess(supabase, groupId, caller.id, caller.role, caller.school);
    if (!access.group || !access.memberRole) return err('group_not_found', 404);
    if (access.group.type === 'school_public') return err('cannot_leave_school_group');

    const { data: admins } = await supabase
      .from('group_members')
      .select('"userId"')
      .eq('groupId', groupId)
      .eq('role', 'admin');

    if (access.memberRole === 'admin' && (admins ?? []).length <= 1) {
      return err('last_admin_cannot_leave');
    }

    const { error: leaveErr } = await supabase
      .from('group_members')
      .delete()
      .eq('groupId', groupId)
      .eq('userId', caller.id);

    if (leaveErr) {
      console.error('group leave error:', leaveErr);
      return err('leave_failed', 500);
    }

    return ok({ groupId });
  }

  return err('unsupported_action');
});
