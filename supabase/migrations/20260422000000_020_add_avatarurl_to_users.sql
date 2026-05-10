-- Migration: 020_add_avatarurl_to_users
-- Adds optional avatarUrl column so the frontend avatar system (avatars.js)
-- can display real profile photos uploaded to Supabase Storage or an external CDN.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;

COMMENT ON COLUMN public.users."avatarUrl" IS
  'Optional profile photo URL. Points to a Supabase Storage public URL or external CDN. NULL = use initials fallback.';
