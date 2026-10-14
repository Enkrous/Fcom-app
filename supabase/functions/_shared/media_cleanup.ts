import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

/** Delete one bounded batch; errors leave paths queued for the next cron run. */
export async function cleanupQueuedChatMedia(supabase: SupabaseClient): Promise<number> {
  const { data: queued, error: queueError } = await supabase
    .from('chat_media_cleanup_queue')
    .select('path')
    .order('createdAt', { ascending: true })
    .limit(100);
  if (queueError) throw queueError;
  const paths = (queued ?? []).map((row: { path: string }) => row.path);
  if (!paths.length) return 0;

  // Fail closed on DB errors: never remove media while reference safety is unknown.
  const { data: referenced, error: referenceError } = await supabase
    .rpc('referenced_chat_media', { p_paths: paths });
  if (referenceError) throw referenceError;
  const retained = new Set((referenced ?? []).map((row: { path: string }) => row.path));
  const orphaned = paths.filter((path: string) => !retained.has(path));

  if (orphaned.length) {
    const { error: storageError } = await supabase.storage.from('chat-media').remove(orphaned);
    if (storageError) throw storageError;
  }
  // Referenced paths can leave the queue too. Future deletion will queue them again.
  const { error: acknowledgeError } = await supabase
    .from('chat_media_cleanup_queue')
    .delete()
    .in('path', paths);
  if (acknowledgeError) throw acknowledgeError;
  return orphaned.length;
}
