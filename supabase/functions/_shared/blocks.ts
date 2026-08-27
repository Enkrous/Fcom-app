import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

type BlockRow = {
  blockerId?: string | null;
  blockedId?: string | null;
};

export async function getBlockedPeerIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  const blockedIds = new Set<string>();

  try {
    const [outgoing, incoming] = await Promise.all([
      supabase
        .from('user_blocks')
        .select('"blockedId"')
        .eq('blockerId', userId),
      supabase
        .from('user_blocks')
        .select('"blockerId"')
        .eq('blockedId', userId),
    ]);

    if (outgoing.error) throw outgoing.error;
    if (incoming.error) throw incoming.error;

    ((outgoing.data ?? []) as BlockRow[]).forEach((row) => {
      if (row.blockedId) blockedIds.add(row.blockedId);
    });
    ((incoming.data ?? []) as BlockRow[]).forEach((row) => {
      if (row.blockerId) blockedIds.add(row.blockerId);
    });
  } catch (error) {
    console.warn('user block lookup skipped:', error);
  }

  return blockedIds;
}

export async function hasUserBlock(
  supabase: SupabaseClient,
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> {
  if (!firstUserId || !secondUserId) return false;

  try {
    const [firstBlocksSecond, secondBlocksFirst] = await Promise.all([
      supabase
        .from('user_blocks')
        .select('"blockerId"', { count: 'exact', head: true })
        .eq('blockerId', firstUserId)
        .eq('blockedId', secondUserId),
      supabase
        .from('user_blocks')
        .select('"blockerId"', { count: 'exact', head: true })
        .eq('blockerId', secondUserId)
        .eq('blockedId', firstUserId),
    ]);

    if (firstBlocksSecond.error) throw firstBlocksSecond.error;
    if (secondBlocksFirst.error) throw secondBlocksFirst.error;

    return Boolean((firstBlocksSecond.count ?? 0) > 0 || (secondBlocksFirst.count ?? 0) > 0);
  } catch (error) {
    console.warn('user block check skipped:', error);
    return false;
  }
}

export async function filterBlockedPeers<T extends { id: string }>(
  supabase: SupabaseClient,
  userId: string,
  users: T[],
): Promise<T[]> {
  const blockedIds = await getBlockedPeerIds(supabase, userId);
  if (!blockedIds.size) return users;
  return users.filter((user) => !blockedIds.has(user.id));
}
