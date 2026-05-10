-- Migration 009: Schedule automatic cleanup via pg_cron
-- Requires the pg_cron extension (enabled by default on Supabase).
--
-- These jobs call the cleanup SQL functions directly from Postgres,
-- without going through an Edge Function. No HTTP overhead.
--
-- Run this AFTER migrations 001–008.

-- Enable pg_cron extension (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage to postgres role (required on Supabase)
GRANT USAGE ON SCHEMA cron TO postgres;

-- Remove previous jobs if re-running this migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-expired-sessions') THEN
    PERFORM cron.unschedule('cleanup-expired-sessions');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-expired-otp') THEN
    PERFORM cron.unschedule('cleanup-expired-otp');
  END IF;
END;
$$;

-- Delete expired sessions every hour at :05
SELECT cron.schedule(
  'cleanup-expired-sessions',
  '5 * * * *',
  $$ SELECT public.cleanup_expired_sessions() $$
);

-- Delete expired OTP codes every hour at :10
SELECT cron.schedule(
  'cleanup-expired-otp',
  '10 * * * *',
  $$ SELECT public.cleanup_expired_otp() $$
);

COMMENT ON EXTENSION pg_cron IS 'Runs cleanup_expired_sessions and cleanup_expired_otp hourly';
