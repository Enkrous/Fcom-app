-- Migration 001: Create users table
-- Preserves all field names used by frontend

CREATE TABLE IF NOT EXISTS public.users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "fullName"    TEXT NOT NULL,
  school        TEXT NOT NULL,
  grade         TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  phone         TEXT,
  "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
  "passwordHash"  TEXT,
  role          TEXT NOT NULL DEFAULT 'member'
                  CHECK (role IN ('member', 'admin')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  cred          NUMERIC(10, 2) NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive unique index on nickname
CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_lower_idx
  ON public.users (LOWER(nickname));

-- Index for school-based queries (multi-school scaling)
CREATE INDEX IF NOT EXISTS users_school_idx ON public.users (school);

-- Index for status queries
CREATE INDEX IF NOT EXISTS users_status_idx ON public.users (status);
CREATE INDEX IF NOT EXISTS users_role_idx ON public.users (role);

COMMENT ON TABLE public.users IS 'Core user table for Fcom / Кредо system';
COMMENT ON COLUMN public.users.cred IS 'Trust score — only modified via apply_cred_delta()';
COMMENT ON COLUMN public.users.status IS 'pending | approved | rejected';
COMMENT ON COLUMN public.users.role IS 'member | admin';
