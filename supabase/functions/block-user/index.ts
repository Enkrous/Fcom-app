import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { rateLimitDb } from '../_shared/ratelimit.ts';
import { isSameSchool } from '../_shared/school.ts';

const PUBLIC_USER_FIELDS = 'id, "fullName", school, grade, nickname, "phoneVerified", role, status, cred, "createdAt", "avatarUrl"';

type BlockRow = {
  blockerId: string;
  blockedId: string;
  createdAt: string;
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
    .select('id, school, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller) return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  if (req.method === 'GET') {
    const result = await loadBlocks(supabase, caller.id);
    if (!result.ok) return err(result.error, 500);
    return ok({ blocks: result.blocks });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  const allowed = await rateLimitDb(supabase, ip, 'block-user', 30, 60_000);
  if (!allowed) return err('rate_limit_exceeded', 429);

  let body: { targetId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const targetId = String(body.targetId ?? '').trim();
  const action = String(body.action ?? 'block').trim();

  if (!targetId) return err('targetId_required');
  if (!['block', 'unblock'].includes(action)) return err('invalid_action');
  if (targetId === caller.id) return err('cannot_block_self');

  const { data: target } = await supabase
    .from('users')
    .select('id, school, status')
    .eq('id', targetId)
    .maybeSingle();

  if (!target) return err('target_not_found', 404);
  if (target.status !== 'approved') return err('target_not_approved', 403);
  if (!isSameSchool(target.school, caller.school)) return err('cross_school_forbidden', 403);

  if (action === 'block') {
    const { error: blockErr } = await supabase
      .from('user_blocks')
      .upsert({
        blockerId: caller.id,
        blockedId: targetId,
      }, { onConflict: 'blockerId,blockedId' });

    if (blockErr) {
      console.error('block user error:', blockErr);
      return err('block_failed', 500);
    }
  } else {
    const { error: unblockErr } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blockerId', caller.id)
      .eq('blockedId', targetId);

    if (unblockErr) {
      console.error('unblock user error:', unblockErr);
      return err('unblock_failed', 500);
    }
  }

  const result = await loadBlocks(supabase, caller.id);
  if (!result.ok) return err(result.error, 500);
  return ok({ targetId, action, blocks: result.blocks });
});

async function loadBlocks(
  supabase: ReturnType<typeof getServiceClient>,
  blockerId: string,
): Promise<{ ok: true; blocks: Array<Record<string, unknown>> } | { ok: false; error: string }> {
  const { data: blocks, error: blocksErr } = await supabase
    .from('user_blocks')
    .select('"blockerId", "blockedId", "createdAt"')
    .eq('blockerId', blockerId)
    .order('createdAt', { ascending: false });

  if (blocksErr) {
    console.error('blocks fetch error:', blocksErr);
    return { ok: false, error: 'fetch_failed' };
  }

  const typedBlocks = (blocks ?? []) as BlockRow[];
  const blockedIds = typedBlocks.map((block) => block.blockedId);

  const { data: users, error: usersErr } = blockedIds.length
    ? await supabase
        .from('users')
        .select(PUBLIC_USER_FIELDS)
        .in('id', blockedIds)
    : { data: [], error: null };

  if (usersErr) {
    console.error('blocked users fetch error:', usersErr);
    return { ok: false, error: 'fetch_failed' };
  }

  const userMap = Object.fromEntries(((users ?? []) as UserRow[]).map((user) => [user.id, user]));
  return {
    ok: true,
    blocks: typedBlocks.map((block) => ({
      ...block,
      user: userMap[block.blockedId] ?? null,
    })),
  };
}
