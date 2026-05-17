import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

const MAX_BYTES = 6 * 1024 * 1024;

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

  const { error: uploadErr } = await supabase.storage
    .from('chat-media')
    .upload(path, file, {
      upsert: false,
      contentType: file.type,
      cacheControl: '3600',
    });

  if (uploadErr) {
    console.error('chat media upload error:', uploadErr);
    return err('upload_failed', 500);
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
});

function getExtension(mime: string, fallbackName: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';

  const parts = String(fallbackName ?? '').split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : 'bin';
}
