import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { getCanonicalSchoolName, isSameSchool } from './school.ts';

export async function ensureSchoolPublicGroup(
  supabase: SupabaseClient,
  school: string,
  userId: string,
) {
  const canonicalSchool = getCanonicalSchoolName(school);

  const { data: schoolGroups, error: groupErr } = await supabase
    .from('chat_groups')
    .select('id, name, school, type')
    .eq('type', 'school_public');

  if (groupErr) throw groupErr;

  const existingGroup = (schoolGroups ?? []).find((group: { school: string }) =>
    isSameSchool(group.school, canonicalSchool),
  );

  const group = existingGroup ?? await createSchoolPublicGroup(supabase, canonicalSchool, userId);

  if (group.school !== canonicalSchool || ('name' in group && group.name !== canonicalSchool)) {
    const { error: updateGroupErr } = await supabase
      .from('chat_groups')
      .update({
        name: canonicalSchool,
        school: canonicalSchool,
      })
      .eq('id', group.id);

    if (updateGroupErr) throw updateGroupErr;
    group.school = canonicalSchool;
    if ('name' in group) group.name = canonicalSchool;
  }

  const { data: membership, error: membershipErr } = await supabase
    .from('group_members')
    .select('"groupId", "userId"')
    .eq('groupId', group.id)
    .eq('userId', userId)
    .maybeSingle();

  if (membershipErr) throw membershipErr;

  if (!membership) {
    const { error: insertMembershipErr } = await supabase
      .from('group_members')
      .insert({
        groupId: group.id,
        userId,
        role: 'member',
        addedBy: group.id ? userId : null,
      });

    if (insertMembershipErr) throw insertMembershipErr;
  }

  return group;
}

async function createSchoolPublicGroup(
  supabase: SupabaseClient,
  school: string,
  userId: string,
) {
  const canonicalSchool = getCanonicalSchoolName(school);
  const { data: createdGroup, error: createErr } = await supabase
    .from('chat_groups')
    .insert({
      name: canonicalSchool,
      school: canonicalSchool,
      type: 'school_public',
      createdBy: userId,
    })
    .select('id, name, school, type')
    .single();

  if (!createErr && createdGroup) {
    const { error: creatorMembershipErr } = await supabase
      .from('group_members')
      .insert({
        groupId: createdGroup.id,
        userId,
        role: 'admin',
        addedBy: userId,
      });

    if (creatorMembershipErr) throw creatorMembershipErr;
    return createdGroup;
  }

  // Another request may have created the group concurrently.
  const { data: racedGroup, error: racedErr } = await supabase
    .from('chat_groups')
    .select('id, name, school, type')
    .eq('type', 'school_public');

  const matchedRacedGroup = (racedGroup ?? []).find((group: { school: string }) =>
    isSameSchool(group.school, canonicalSchool),
  );

  if (racedErr || !matchedRacedGroup) throw createErr ?? racedErr ?? new Error('school_group_create_failed');
  return matchedRacedGroup;
}

export async function getGroupAccess(
  supabase: SupabaseClient,
  groupId: string,
  userId: string,
  callerRole: string,
  callerSchool: string,
) {
  const { data: group, error: groupErr } = await supabase
    .from('chat_groups')
    .select('id, name, school, type, "createdBy", "avatarUrl", "createdAt"')
    .eq('id', groupId)
    .maybeSingle();

  if (groupErr) throw groupErr;
  if (!group) return { group: null, memberRole: null, canView: false, canManage: false };

  const { data: membership, error: membershipErr } = await supabase
    .from('group_members')
    .select('role')
    .eq('groupId', groupId)
    .eq('userId', userId)
    .maybeSingle();

  if (membershipErr) throw membershipErr;

  const isFcomAdmin = callerRole === 'admin';
  let memberRole = membership?.role ?? null;
  let isMember = Boolean(membership);

  if (group.type === 'school_public' && !isFcomAdmin) {
    if (!isSameSchool(group.school, callerSchool)) {
      return { group, memberRole, canView: false, canManage: false };
    }

    if (!isMember) {
      const { error: insertMembershipErr } = await supabase
        .from('group_members')
        .upsert({
          groupId,
          userId,
          role: 'member',
          addedBy: userId,
        }, { onConflict: 'groupId,userId' });

      if (insertMembershipErr) throw insertMembershipErr;
      memberRole = 'member';
      isMember = true;
    }
  }

  const canView = isMember || isFcomAdmin;
  const canManage = memberRole === 'admin';

  return {
    group,
    memberRole,
    canView,
    canManage,
  };
}
