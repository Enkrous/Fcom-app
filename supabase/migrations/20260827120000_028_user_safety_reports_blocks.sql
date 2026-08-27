-- Migration 028: User safety reports and blocks
--
-- Adds the minimal database surface for the web SPA safety flows:
--   - user_reports: user-submitted reports reviewed by admins;
--   - user_blocks: pairwise user blocks that hide/directly restrict contact.
--
-- It also reasserts the group-table service_role policies from migration 027.
-- Some live migration histories can mark 027 as applied before the policy
-- section existed, so this keeps the security model idempotently reconciled.
--
-- The frontend must not write these tables through PostgREST. Reads and writes
-- go through Edge Functions that use the service_role client and enforce
-- application-level authorization.
--
-- Rollback, if this subsystem is intentionally removed later:
--   DROP POLICY IF EXISTS "user_reports_service_role_all" ON public.user_reports;
--   DROP POLICY IF EXISTS "user_blocks_service_role_all" ON public.user_blocks;
--   DROP TABLE IF EXISTS public.user_reports;
--   DROP TABLE IF EXISTS public.user_blocks;
--   DROP POLICY IF EXISTS "chat_groups_service_role_all" ON public.chat_groups;
--   DROP POLICY IF EXISTS "group_members_service_role_all" ON public.group_members;
--   DROP POLICY IF EXISTS "group_invites_service_role_all" ON public.group_invites;

ALTER TABLE public.chat_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.chat_groups   FROM PUBLIC;
REVOKE ALL ON TABLE public.group_members FROM PUBLIC;
REVOKE ALL ON TABLE public.group_invites FROM PUBLIC;

REVOKE ALL ON TABLE public.chat_groups   FROM anon, authenticated;
REVOKE ALL ON TABLE public.group_members FROM anon, authenticated;
REVOKE ALL ON TABLE public.group_invites FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_groups   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_invites TO service_role;

DROP POLICY IF EXISTS "chat_groups_service_role_all" ON public.chat_groups;
DROP POLICY IF EXISTS "group_members_service_role_all" ON public.group_members;
DROP POLICY IF EXISTS "group_invites_service_role_all" ON public.group_invites;

CREATE POLICY "chat_groups_service_role_all"
  ON public.chat_groups
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "group_members_service_role_all"
  ON public.group_members
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "group_invites_service_role_all"
  ON public.group_invites
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.user_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reporterId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  "targetId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN (
    'spam',
    'harassment',
    'fake_account',
    'inappropriate_content',
    'other'
  )),
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',
    'reviewed',
    'dismissed',
    'actioned'
  )),
  "reviewedBy" UUID REFERENCES public.users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reviewedAt" TIMESTAMPTZ,
  CHECK ("reporterId" <> "targetId")
);

CREATE INDEX IF NOT EXISTS user_reports_target_status_idx
  ON public.user_reports ("targetId", status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS user_reports_reporter_idx
  ON public.user_reports ("reporterId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS public.user_blocks (
  "blockerId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  "blockedId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("blockerId", "blockedId"),
  CHECK ("blockerId" <> "blockedId")
);

CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx
  ON public.user_blocks ("blockedId", "createdAt" DESC);

ALTER TABLE public.user_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_blocks  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_reports FROM PUBLIC;
REVOKE ALL ON TABLE public.user_blocks  FROM PUBLIC;

REVOKE ALL ON TABLE public.user_reports FROM anon, authenticated;
REVOKE ALL ON TABLE public.user_blocks  FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_reports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_blocks  TO service_role;

-- No anon/authenticated policies are created on purpose: browser code must use
-- Edge Functions, not direct PostgREST reads or writes.
DROP POLICY IF EXISTS "user_reports_service_role_all" ON public.user_reports;
DROP POLICY IF EXISTS "user_blocks_service_role_all" ON public.user_blocks;

CREATE POLICY "user_reports_service_role_all"
  ON public.user_reports
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "user_blocks_service_role_all"
  ON public.user_blocks
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.user_reports
  IS 'User safety reports submitted through Edge Functions and reviewed by admins. Direct anon/authenticated access is revoked.';

COMMENT ON TABLE public.user_blocks
  IS 'Pairwise user blocks managed through Edge Functions. Direct anon/authenticated access is revoked.';
