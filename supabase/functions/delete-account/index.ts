/**
 * Edge Function: POST /functions/v1/delete-account
 *
 * Permanently deletes the authenticated user's account and all rows that
 * reference it through the database cascade rules. The endpoint is
 * intentionally self-service: it never accepts a target user id.
 */

import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

type MessageRow = { attachmentPath?: string | null };

const STORAGE_BUCKET = 'chat-media';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id')
    .eq('id', payload.sub)
    .maybeSingle();

  if (userError) {
    console.error('delete account user lookup error:', userError);
    return err('delete_failed', 500);
  }
  if (!user) return err('user_not_found', 404);

  // Remove private chat-media objects that would otherwise become orphaned
  // when the database cascade deletes their messages. Storage cleanup is
  // best-effort; the account deletion itself must still complete.
  await removeUserMedia(supabase, payload.sub);

  const { error: sessionError } = await supabase
    .from('sessions')
    .delete()
    .eq('userId', payload.sub);
  if (sessionError) {
    console.error('delete account sessions error:', sessionError);
    return err('delete_failed', 500);
  }

  const { error: deleteError } = await supabase
    .from('users')
    .delete()
    .eq('id', payload.sub);

  if (deleteError) {
    console.error('delete account user error:', deleteError);
    return err('delete_failed', 500);
  }

  return ok({ deletedUserId: payload.sub });
});

async function removeUserMedia(
  supabase: ReturnType<typeof getServiceClient>,
  userId: string,
): Promise<void> {
  const paths = new Set<string>();

  const direct = await supabase
    .from('messages')
    .select('"attachmentPath"')
    .or(`"fromId".eq.${userId},"toId".eq.${userId}`);
  collectPaths(paths, direct.data as MessageRow[] | null);

  const { data: ownedGroups } = await supabase
    .from('chat_groups')
    .select('id')
    .eq('createdBy', userId);
  const groupIds = (ownedGroups ?? [])
    .map((group) => String(group.id ?? ''))
    .filter(Boolean);

  if (groupIds.length) {
    const groupMessages = await supabase
      .from('messages')
      .select('"attachmentPath"')
      .in('groupId', groupIds);
    collectPaths(paths, groupMessages.data as MessageRow[] | null);
  }

  // Uploaded media uses the user's id as the first path segment. Listing
  // this prefix also catches files from messages that were already deleted.
  const folders = await supabase.storage.from(STORAGE_BUCKET).list(userId, { limit: 1000 });
  for (const folder of folders.data ?? []) {
    if (folder.id) {
      paths.add(`${userId}/${folder.name}`);
      continue;
    }
    const files = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(`${userId}/${folder.name}`, { limit: 1000 });
    for (const file of files.data ?? []) {
      if (file.id) paths.add(`${userId}/${folder.name}/${file.name}`);
    }
  }

  const list = [...paths];
  for (let index = 0; index < list.length; index += 100) {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(list.slice(index, index + 100));
    if (error) console.warn('delete account media cleanup error:', error);
  }
}

function collectPaths(target: Set<string>, rows: MessageRow[] | null): void {
  for (const row of rows ?? []) {
    const path = String(row.attachmentPath ?? '').trim();
    if (path) target.add(path);
  }
}
