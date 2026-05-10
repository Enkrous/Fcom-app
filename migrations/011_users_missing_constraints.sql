-- Migration 011: Missing uniqueness constraints on users table
--
-- Adds:
--   1. Case-insensitive unique index on "fullName"
--   2. Unique partial index on phone (NULL values allowed — only non-NULL must be unique)
--
-- Run AFTER migration 001.

-- ── 1. fullName: case-insensitive uniqueness ──────────────────────────────────
-- Prevents two users with names differing only by case (e.g. "Ivan" vs "ivan").
CREATE UNIQUE INDEX IF NOT EXISTS users_fullname_lower_idx
  ON public.users (LOWER("fullName"));

COMMENT ON INDEX public.users_fullname_lower_idx
  IS 'Enforces case-insensitive uniqueness of fullName';

-- ── 2. phone: unique when provided ───────────────────────────────────────────
-- Prevents the same phone number from being registered twice.
-- NULL is allowed (phone is optional), but two rows cannot share the same
-- non-NULL phone value (standard Postgres behaviour for UNIQUE partial indexes).
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique_idx
  ON public.users (phone)
  WHERE phone IS NOT NULL;

COMMENT ON INDEX public.users_phone_unique_idx
  IS 'Enforces phone uniqueness; NULLs are excluded (phone is optional)';
