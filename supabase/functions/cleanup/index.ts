/**
 * Edge Function: POST /functions/v1/cleanup
 *
 * Protected by CLEANUP_SECRET environment variable.
 * Designed to be called by Supabase Cron Jobs or an external scheduler.
 *
 * Calls:
 *   - cleanup_expired_sessions()  — purges sessions past their expiresAt
 *   - cleanup_expired_otp()       — purges OTP codes past their expiresAt
 *   - cleanup_rate_limit_log()    — purges rate_limit_log entries older than 1 hour
 *
 * Response: { ok: true, deleted: { sessions, otp, rateLimitLog } }
 */

import { ok, err, corsPrelight } from '../_shared/response.ts';
import { getServiceClient }      from '../_shared/db.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();
  if (req.method !== 'POST') return err('method_not_allowed', 405);

  const cleanupSecret = Deno.env.get('CLEANUP_SECRET');
  if (!cleanupSecret) return err('server_misconfigured', 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (provided !== cleanupSecret) return err('forbidden', 403);

  const supabase = getServiceClient();

  const [
    { data: deletedSessions, error: sessErr },
    { data: deletedOtp,      error: otpErr  },
    { data: deletedRl,       error: rlErr   },
  ] = await Promise.all([
    supabase.rpc('cleanup_expired_sessions'),
    supabase.rpc('cleanup_expired_otp'),
    supabase.rpc('cleanup_rate_limit_log'),
  ]);

  if (sessErr) console.error('cleanup_expired_sessions error:', sessErr);
  if (otpErr)  console.error('cleanup_expired_otp error:', otpErr);
  if (rlErr)   console.error('cleanup_rate_limit_log error:', rlErr);

  return ok({
    deleted: {
      sessions:     Number(deletedSessions ?? 0),
      otp:          Number(deletedOtp      ?? 0),
      rateLimitLog: Number(deletedRl       ?? 0),
    },
  });
});
