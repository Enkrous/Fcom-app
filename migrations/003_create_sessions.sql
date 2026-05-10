-- Migration 003: Create sessions table
-- JWT is stored client-side; this table enables server-side revocation

CREATE TABLE IF NOT EXISTS public.sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"    UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  jti         UUID NOT NULL UNIQUE,   -- JWT ID claim, used for revocation
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON public.sessions ("userId");
CREATE INDEX IF NOT EXISTS sessions_jti_idx     ON public.sessions (jti);

-- Auto-cleanup: delete expired sessions older than 1 day
-- (run periodically via pg_cron or a scheduled Edge Function)
COMMENT ON TABLE public.sessions IS 'Active JWT sessions — allows server-side token revocation';
COMMENT ON COLUMN public.sessions.jti IS 'Matches the jti claim in the JWT';
