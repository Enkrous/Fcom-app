-- Migration 007: Row Level Security policies
-- Edge Functions use service_role key and bypass RLS entirely.
-- These policies protect direct PostgREST / anon access.

-- ============================================================
-- USERS
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read their own row
CREATE POLICY "users_select_own"
  ON public.users FOR SELECT
  USING (id = auth.uid());

-- Approved users can read other approved users in the same school
CREATE POLICY "users_select_approved_same_school"
  ON public.users FOR SELECT
  USING (
    status = 'approved'
    AND school = (
      SELECT school FROM public.users WHERE id = auth.uid()
    )
  );

-- Approved users can see pending users in the same school (for approval flow)
CREATE POLICY "users_select_pending_same_school"
  ON public.users FOR SELECT
  USING (
    status = 'pending'
    AND school = (
      SELECT school FROM public.users WHERE id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND status = 'approved'
    )
  );

-- No direct INSERT/UPDATE/DELETE via PostgREST — all writes go through Edge Functions
-- (service_role bypasses RLS, anon/authenticated cannot write)

-- ============================================================
-- MESSAGES
-- ============================================================
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_select_participant"
  ON public.messages FOR SELECT
  USING ("fromId" = auth.uid() OR "toId" = auth.uid());

-- No direct write via PostgREST

-- ============================================================
-- RATE_LOG
-- ============================================================
ALTER TABLE public.rate_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rate_log_select_participant"
  ON public.rate_log FOR SELECT
  USING ("from" = auth.uid() OR "to" = auth.uid());

-- ============================================================
-- SENSITIVE TABLES — blocked from any direct access
-- (otp_codes, sessions, device_blocks)
-- ============================================================
ALTER TABLE public.otp_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_blocks ENABLE ROW LEVEL SECURITY;

-- No policies = no access for anon or authenticated roles
-- Only service_role (Edge Functions) can read/write these tables
