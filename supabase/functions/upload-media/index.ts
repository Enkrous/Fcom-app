import { ok, err, corsPrelight, withErrorHandling }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

const MAX_BYTES = 6 * 1024 * 1024;

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

  const { data: caller } = await supabase
    .from('users')
    .select('id, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller) return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err('invalid_form_data');
  }

  const file = form.get('file');
  if (!(file instanceof File)) return err('file_required');
  if (!file.type.startsWith('image/')) return err('image_only');
  if (file.size <= 0) return err('empty_file');
  if (file.size > MAX_BYTES) return err('file_too_large');

  const width = Number(form.get('width') ?? 0) || null;
  const height = Number(form.get('height') ?? 0) || null;
  const ext = getExtension(file.type, file.name);
  const path = `${caller.id}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;

  let uploadErr: unknown;
  try {
    const result = await supabase.storage.from('chat-media').upload(path, file, {
        upsert: false,
        contentType: file.type,
        cacheControl: '3600',
      });
    uploadErr = result.error;
  } catch (error) {
    uploadErr = error;
  }

  if (uploadErr) {
    console.error('chat media upload error:', uploadErr);
    // A lost Storage response can hide an already committed object. Its fresh
    // unpublished path is safe to discard even when upload success is unknown.
    await discardUnpublishedUpload(supabase, path);
    return err('upload_failed', 500);
  }

  let finalized: unknown;
  let finalizeError: unknown;
  try {
    const result = await supabase.rpc('finalize_chat_media_upload', {
      p_user_id: caller.id,
      p_path: path,
    });
    finalized = result.data;
    finalizeError = result.error;
  } catch (error) {
    finalizeError = error;
  }
  if (finalizeError || typeof finalized !== 'boolean') {
    console.error('chat media finalization error:', finalizeError);
    await discardUnpublishedUpload(supabase, path);
    return err('upload_failed', 500);
  }
  if (!finalized) {
    // Deletion cascaded the caller's sessions. Do not publish a successful
    // upload for the vanished account, even if its original JWT was valid.
    await discardUnpublishedUpload(supabase, path);
    return err('session_revoked', 401);
  }

  return ok({
    media: {
      path,
      mime: file.type,
      bytes: file.size,
      width,
      height,
    },
  });
}));

// This UUID path belongs to the just-completed upload and has never been
// published to the caller. Queue first, then remove only that new object.
// Cleanup failures keep the durable queue entry for the protected cron job.
async function discardUnpublishedUpload(
  supabase: ReturnType<typeof getServiceClient>,
  path: string,
): Promise<void> {
  try {
    const { error } = await supabase.from('chat_media_cleanup_queue')
      .upsert({ path }, { onConflict: 'path' });
    if (error) console.warn('unpublished media queue error:', error);
  } catch (error) {
    console.warn('unpublished media queue error:', error);
  }
  try {
    const { error } = await supabase.storage.from('chat-media').remove([path]);
    if (error) {
      console.warn('unpublished media removal error:', error);
      return;
    }
  } catch (error) {
    console.warn('unpublished media removal error:', error);
    return;
  }
  try {
    const { error } = await supabase.from('chat_media_cleanup_queue')
      .delete().eq('path', path);
    if (error) console.warn('unpublished media queue acknowledge error:', error);
  } catch (error) {
    console.warn('unpublished media queue acknowledge error:', error);
  }
}

function getExtension(mime: string, fallbackName: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';

  const parts = String(fallbackName ?? '').split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : 'bin';
}
