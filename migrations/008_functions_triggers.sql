-- Migration 008: SQL functions and triggers

-- ============================================================
-- apply_cred_delta
-- The ONLY permitted way to modify a user's cred.
-- Called exclusively from the rate Edge Function via service_role.
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_cred_delta(
  target_id UUID,
  delta      NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_cred NUMERIC;
BEGIN
  UPDATE public.users
  SET cred = GREATEST(0, ROUND(cred + delta, 2))
  WHERE id = target_id
  RETURNING cred INTO new_cred;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % not found', target_id;
  END IF;

  RETURN new_cred;
END;
$$;

-- Revoke direct execute from public/anon — only service_role may call it
REVOKE ALL ON FUNCTION public.apply_cred_delta(UUID, NUMERIC) FROM PUBLIC;

-- ============================================================
-- get_daily_cred_change
-- Returns total absolute effectiveDelta applied to a user in the last 24 h.
-- Used to enforce the MAX_DAILY_CHANGE = 5 cap (mirrors credo.js).
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_daily_cred_change(target_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(ABS("effectiveDelta")), 0)
  FROM public.rate_log
  WHERE "to" = target_id
    AND date > now() - INTERVAL '24 hours';
$$;

REVOKE ALL ON FUNCTION public.get_daily_cred_change(UUID) FROM PUBLIC;

-- ============================================================
-- get_times_rated
-- Returns how many times fromId has previously rated toId.
-- Used for repeat-decay calculation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_times_rated(from_id UUID, to_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.rate_log
  WHERE "from" = from_id AND "to" = to_id;
$$;

REVOKE ALL ON FUNCTION public.get_times_rated(UUID, UUID) FROM PUBLIC;

-- ============================================================
-- had_conversation
-- Returns true if at least one message exists between two users.
-- Required by canRate check.
-- ============================================================
CREATE OR REPLACE FUNCTION public.had_conversation(id1 UUID, id2 UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.messages
    WHERE ("fromId" = id1 AND "toId" = id2)
       OR ("fromId" = id2 AND "toId" = id1)
  );
$$;

REVOKE ALL ON FUNCTION public.had_conversation(UUID, UUID) FROM PUBLIC;

-- ============================================================
-- auto_approve_first  (trigger function)
-- If no approved user exists for the school yet, the first
-- registrant is immediately approved with cred = 1.
-- Mirrors the `hasApproved` check in credo.js registerUser().
-- ============================================================
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
    NEW.status := 'approved';
    NEW.cred   := 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_approve ON public.users;
CREATE TRIGGER trg_auto_approve
  BEFORE INSERT ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_approve_first();

-- ============================================================
-- cleanup_expired_sessions  (utility, call via pg_cron or Edge Function)
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_expired_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM public.sessions
  WHERE "expiresAt" < now();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- ============================================================
-- cleanup_expired_otp  (utility)
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_expired_otp()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM public.otp_codes
  WHERE "expiresAt" < now() - INTERVAL '1 hour';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
