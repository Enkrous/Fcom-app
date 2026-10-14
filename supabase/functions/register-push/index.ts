import { ok, err, corsPrelight, withErrorHandling } from '../_shared/response.ts';
import { getServiceClient } from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { rateLimitDb } from '../_shared/ratelimit.ts';
import { getPushEnvironment, parsePushRegistration } from '../_shared/push.ts';

Deno.serve(withErrorHandling(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);
  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);
  const supabase = getServiceClient();
  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (error) {
    return err((error as Error).message ?? 'unauthorized', 401);
  }
  // Pending users need a device token before admins approve them.
  if (!['approved', 'pending'].includes(payload.status ?? '')) return err('forbidden', 403);

  let body: unknown;
  try { body = await req.json(); } catch { return err('invalid_json'); }
  let defaultEnvironment;
  try { defaultEnvironment = getPushEnvironment(Deno.env.get('APNS_ENVIRONMENT')); }
  catch { return err('server_misconfigured', 500); }
  const parsed = parsePushRegistration(body, defaultEnvironment);
  if (!parsed.ok) return err(parsed.error);
  try {
    if (!await rateLimitDb(supabase, payload.sub, 'register-push', 30, 60_000, true)) {
      return err('rate_limit_exceeded', 429);
    }
  } catch { return err('rate_limit_unavailable', 503); }

  const { token, platform, action, environment } = parsed.value;
  if (action === 'unregister') {
    const { error } = await supabase.from('device_tokens').delete()
      .eq('userId', payload.sub).eq('token', token).eq('platform', platform).eq('environment', environment);
    if (error) return err('unregister_failed', 500);
    return ok({ action, registered: false });
  }
  const { data: device, error } = await supabase.from('device_tokens')
    .upsert({ userId: payload.sub, token, platform, environment }, { onConflict: 'platform,environment,token' })
    .select('platform, environment, "createdAt", "updatedAt"').single();
  if (error || !device) return err('registration_failed', 500);
  return ok({ action, registered: true, device });
}));
