-- Migration 019: Security hardening — explicit REVOKE + column security + safe views
--
-- Layers added on top of the existing RLS policies (migration 007):
--
--   1. Explicit REVOKE of INSERT/UPDATE/DELETE on all write-sensitive tables
--      from anon and authenticated roles.  RLS alone blocks unauthorized rows,
--      but table-level REVOKE removes the privilege entirely — defense-in-depth.
--
--   2. Explicit REVOKE of ALL on fully private tables (no direct access at all).
--
--   3. Column-level protection: passwordHash, phone, phoneVerified are stripped
--      from the authenticated role's SELECT grant by revoking table-level SELECT
--      and re-granting only the safe column list.
--
--   4. users_safe VIEW — a stable, narrow projection of the users table that
--      exposes only fields safe to return to any authenticated user.  Future
--      direct PostgREST calls should target this view, not the base table.
--
--   5. Trigger: prevent_direct_cred_status_change — raises an exception if
--      cred or status are updated outside of the sanctioned SQL functions
--      (apply_cred_delta, approve_and_log, reject_and_log, auto_approve_first).
--      Acts as a final DB-level guard even if service_role is somehow misused.
--
-- Run AFTER migrations 001–018.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. REVOKE write privileges on public-facing tables
--    (writes must go through Edge Functions using service_role)
-- ═══════════════════════════════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE ON public.users        FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.messages     FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.rate_log     FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.approval_log FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. REVOKE ALL on fully private tables
--    (service_role only — no direct read or write ever)
-- ═══════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON public.otp_codes      FROM anon, authenticated;
REVOKE ALL ON public.sessions       FROM anon, authenticated;
REVOKE ALL ON public.device_blocks  FROM anon, authenticated;
REVOKE ALL ON public.rate_limit_log FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Column-level protection on users table
--    Strip SELECT on sensitive columns; re-grant only the safe column set.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Remove table-level SELECT first (column-level grants take precedence after this)
REVOKE SELECT ON public.users FROM anon, authenticated;

-- Grant only the columns safe to expose via direct PostgREST (RLS still applies)
GRANT SELECT (
  id,
  "fullName",
  school,
  grade,
  nickname,
  status,
  cred,
  "createdAt"
) ON public.users TO authenticated;

-- anon role: allow reading only what's needed for the login screen (nickname check)
-- In practice auth.uid() = NULL for custom JWT so no rows are returned anyway.
GRANT SELECT (id, nickname, school, status) ON public.users TO anon;

COMMENT ON COLUMN public.users."passwordHash"
  IS 'PRIVATE — bcrypt/PBKDF2 hash. Excluded from column-level GRANTs; Edge Functions only.';

COMMENT ON COLUMN public.users.phone
  IS 'PRIVATE — PII. Excluded from column-level GRANTs; Edge Functions only.';

COMMENT ON COLUMN public.users."phoneVerified"
  IS 'PRIVATE — internal state. Excluded from column-level GRANTs; Edge Functions only.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. users_safe VIEW
--    Stable projection for any future direct PostgREST use.
--    Omits: passwordHash, phone, phoneVerified.
--    security_invoker=true means the caller's RLS policies still apply.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.users_safe
WITH (security_invoker = true)
AS
  SELECT
    id,
    "fullName",
    school,
    grade,
    nickname,
    status,
    cred,
    "createdAt"
  FROM public.users;

GRANT SELECT ON public.users_safe TO authenticated;

COMMENT ON VIEW public.users_safe
  IS 'Safe read-only projection of users — excludes passwordHash, phone, phoneVerified. '
     'security_invoker=true means the RLS policies on the base table still apply. '
     'All Edge Functions use the base table via service_role.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Trigger: prevent direct cred / status changes
--    Raises an exception if cred or status are modified by any session that
--    has NOT set the app.allow_direct_write session variable to 'true'.
--    The sanctioned SECURITY DEFINER functions (apply_cred_delta,
--    approve_and_log, reject_and_log, auto_approve_first) set this variable
--    before performing their UPDATE, so they pass through unimpeded.
--    Any other UPDATE attempt is rejected at the DB level.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_cred_and_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow the change only when the authorised internal functions have set the flag
  IF current_setting('app.allow_direct_write', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.cred <> OLD.cred THEN
    RAISE EXCEPTION
      'Direct update of users.cred is forbidden. Use apply_cred_delta() instead.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status <> OLD.status THEN
    RAISE EXCEPTION
      'Direct update of users.status is forbidden. Use approve_and_log() or reject_and_log().'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_cred_and_status() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_guard_cred_and_status ON public.users;
CREATE TRIGGER trg_guard_cred_and_status
  BEFORE UPDATE OF cred, status ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_cred_and_status();

COMMENT ON TRIGGER trg_guard_cred_and_status ON public.users
  IS 'Blocks any direct UPDATE of cred or status unless app.allow_direct_write = true '
     'is set by the authorised SECURITY DEFINER function in the same transaction.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Patch the sanctioned update functions to set the allow flag
--    Re-create apply_cred_delta, approve_and_log, reject_and_log with
--    SET LOCAL "app.allow_direct_write" = 'true' before each UPDATE.
-- ═══════════════════════════════════════════════════════════════════════════════

-- apply_cred_delta (originally in migration 008)
CREATE OR REPLACE FUNCTION public.apply_cred_delta(
  target_id UUID,
  delta     NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_cred NUMERIC;
BEGIN
  PERFORM set_config('app.allow_direct_write', 'true', true);

  UPDATE public.users
  SET cred = GREATEST(0, ROUND(cred + delta, 2))
  WHERE id = target_id
  RETURNING cred INTO new_cred;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_cred_delta: user % not found', target_id;
  END IF;

  RETURN new_cred;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_cred_delta(UUID, NUMERIC) FROM PUBLIC;

-- approve_and_log (originally in migration 016)
CREATE OR REPLACE FUNCTION public.approve_and_log(
  p_actor_id  UUID,
  p_target_id UUID
)
RETURNS TABLE (user_id UUID, user_status TEXT, user_cred NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_cred NUMERIC;
BEGIN
  PERFORM set_config('app.actor_id',          p_actor_id::TEXT, true);
  PERFORM set_config('app.allow_direct_write', 'true',          true);

  UPDATE public.users SET status = 'approved' WHERE id = p_target_id;
  SELECT public.apply_cred_delta(p_target_id, 1::NUMERIC) INTO v_new_cred;

  RETURN QUERY SELECT p_target_id, 'approved'::TEXT, v_new_cred;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_and_log(UUID, UUID) FROM PUBLIC;

-- reject_and_log (originally in migration 016)
CREATE OR REPLACE FUNCTION public.reject_and_log(
  p_actor_id    UUID,
  p_target_id   UUID,
  p_fingerprint TEXT DEFAULT NULL
)
RETURNS TABLE (user_id UUID, user_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.actor_id',          p_actor_id::TEXT, true);
  PERFORM set_config('app.allow_direct_write', 'true',          true);

  UPDATE public.users SET status = 'rejected' WHERE id = p_target_id;

  IF p_fingerprint IS NOT NULL AND trim(p_fingerprint) <> '' THEN
    INSERT INTO public.device_blocks (fingerprint)
    VALUES (trim(p_fingerprint))
    ON CONFLICT (fingerprint) DO NOTHING;
  END IF;

  RETURN QUERY SELECT p_target_id, 'rejected'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_and_log(UUID, UUID, TEXT) FROM PUBLIC;

-- auto_approve_first trigger function (originally in migration 008)
-- Patch: sets allow_direct_write before modifying NEW record fields
CREATE OR REPLACE FUNCTION public.auto_approve_first()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE school = NEW.school
      AND status = 'approved'
  ) THEN
    PERFORM set_config('app.allow_direct_write', 'true', true);
    NEW.status := 'approved';
    NEW.cred   := 1;
  END IF;
  RETURN NEW;
END;
$$;

-- rate_and_apply (originally in migration 017) — cred change only, no status
CREATE OR REPLACE FUNCTION public.rate_and_apply(
  p_from_id         UUID,
  p_to_id           UUID,
  p_score           INTEGER,
  p_weight          NUMERIC,
  p_base_delta      NUMERIC,
  p_effective_delta NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_cred NUMERIC;
BEGIN
  INSERT INTO public.rate_log (
    "from", "to", score, weight, "baseDelta", "effectiveDelta"
  ) VALUES (
    p_from_id, p_to_id, p_score, p_weight, p_base_delta, p_effective_delta
  );

  PERFORM set_config('app.allow_direct_write', 'true', true);

  UPDATE public.users
  SET cred = GREATEST(0, ROUND(cred + p_effective_delta, 2))
  WHERE id = p_to_id
  RETURNING cred INTO v_new_cred;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rate_and_apply: target user % not found', p_to_id;
  END IF;

  RETURN v_new_cred;
END;
$$;

REVOKE ALL ON FUNCTION public.rate_and_apply(UUID, UUID, INTEGER, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Ensure RLS is enabled on every table (idempotent safety net)
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_log ENABLE ROW LEVEL SECURITY;

COMMENT ON SCHEMA public
  IS 'Fcom / Кредо — all writes via Edge Functions (service_role). '
     'Direct PostgREST access is restricted by RLS + column-level GRANTs. '
     'Sensitive tables (otp_codes, sessions, device_blocks, rate_limit_log) '
     'are fully blocked from anon and authenticated roles.';
