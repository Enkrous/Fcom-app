-- Migration 010: Persistent rate limit log
-- Replaces the in-memory token bucket in _shared/ratelimit.ts.
-- Works correctly across multiple Edge Function worker instances.
-- Run AFTER migration 009 (pg_cron must be available).

CREATE TABLE IF NOT EXISTS public.rate_limit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL,       -- "action:identifier" (e.g. "login:1.2.3.4")
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast window-based COUNT queries
CREATE INDEX IF NOT EXISTS rate_limit_log_key_created_idx
  ON public.rate_limit_log (key, "createdAt");

-- Block all direct access — only service_role (Edge Functions) may write
ALTER TABLE public.rate_limit_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.rate_limit_log IS
  'Persistent rate limit counters — replaces in-memory bucket in ratelimit.ts';

-- Utility: delete entries older than 1 hour
CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_log()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM public.rate_limit_log
  WHERE "createdAt" < now() - INTERVAL '1 hour';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_rate_limit_log() FROM PUBLIC;

-- Schedule cleanup every hour at :15 (after session and OTP cleanup)
SELECT cron.schedule(
  'cleanup-rate-limit-log',
  '15 * * * *',
  $$ SELECT public.cleanup_rate_limit_log() $$
);
