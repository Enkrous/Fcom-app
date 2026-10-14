/**
 * POST /functions/v1/delete-account — authenticated, self-service deletion.
 * Ownership transfer, direct-message deletion, sender tombstones and session
 * revocation share one DB transaction. Storage cleanup starts only after commit.
 */
import { ok, err, corsPrelight, withErrorHandling } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { cleanupQueuedChatMedia } from '../_shared/media_cleanup.ts';

Deno.serve(withErrorHandling(async (req: Request) => {
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

  const { data: deletedUserId, error: deleteError } = await supabase
    .rpc('delete_account_preserving_groups', { p_user_id: payload.sub });
  if (deleteError) {
    console.error('delete account transaction error:', deleteError);
    return err('delete_failed', 500);
  }
  if (!deletedUserId) return err('user_not_found', 404);

  // Storage failure must not reverse or misreport a committed account deletion.
  // The persisted queue allows the protected /cleanup job to retry later.
  try {
    await cleanupQueuedChatMedia(supabase);
  } catch (e: unknown) {
    console.warn('delete account queued media cleanup error:', e);
  }
  return ok({ deletedUserId });
}));
