-- Migration 027: Harden group table direct access
--
-- Migration 024 added chat_groups, group_members, and group_invites after the
-- original security hardening pass in migration 019. These tables are managed
-- exclusively through Edge Functions that use the service_role client, so
-- anon/authenticated clients must not be able to access them directly through
-- PostgREST.
--
-- This migration is intentionally narrow and idempotent:
--   - enable RLS on all group tables;
--   - remove all direct table privileges from PUBLIC, anon, and authenticated;
--   - keep explicit table privileges and RLS policies only for service_role;
--   - leave writes/reads to Edge Functions using service_role, which bypasses
--     RLS after doing application-level authorization.
--
-- Rollback, if direct PostgREST access is deliberately introduced later:
--   DROP the service_role policies below, DISABLE RLS on these tables only if
--   that is an intentional architecture change, then grant only the exact
--   SELECT/INSERT/UPDATE/DELETE operations needed by anon/authenticated.

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

-- No anon/authenticated policies are created on purpose: frontend access goes
-- through Edge Functions, not direct PostgREST table reads or writes.
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

COMMENT ON TABLE public.chat_groups
  IS 'Closed private groups and per-school public groups for the messenger. Direct anon/authenticated access is revoked; use Edge Functions.';

COMMENT ON TABLE public.group_members
  IS 'Active group memberships. Direct anon/authenticated access is revoked; use Edge Functions.';

COMMENT ON TABLE public.group_invites
  IS 'Invite-only flow for private groups. Direct anon/authenticated access is revoked; use Edge Functions.';
