-- Migration 012: Database-level integrity constraints for rate_log
--
-- Adds:
--   1. CHECK constraint: a user cannot rate themselves
--   2. BEFORE INSERT trigger: enforces 24-hour cooldown between ratings
--      of the same (from, to) pair — raises an exception if a rating was
--      already submitted within the last 24 hours.
--
-- The 24h check is also enforced at application level (rate/index.ts) for
-- fast rejection; this trigger is the final authoritative guard.
--
-- Run AFTER migration 005.

-- ── 1. Self-rating prevention ─────────────────────────────────────────────────
-- Cannot be done as a simple column CHECK; must reference two columns.
ALTER TABLE public.rate_log
  DROP CONSTRAINT IF EXISTS rate_log_no_self_rate;

ALTER TABLE public.rate_log
  ADD CONSTRAINT rate_log_no_self_rate
  CHECK ("from" <> "to");

COMMENT ON CONSTRAINT rate_log_no_self_rate ON public.rate_log
  IS 'A user cannot rate themselves';

-- ── 2. 24-hour cooldown trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_rate_cooldown()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.rate_log
    WHERE "from" = NEW."from"
      AND "to"   = NEW."to"
      AND date   > now() - INTERVAL '24 hours'
  ) THEN
    RAISE EXCEPTION
      'rate_cooldown: user % has already rated user % within the last 24 hours',
      NEW."from", NEW."to"
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_rate_cooldown() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_rate_cooldown ON public.rate_log;
CREATE TRIGGER trg_rate_cooldown
  BEFORE INSERT ON public.rate_log
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_rate_cooldown();

COMMENT ON TRIGGER trg_rate_cooldown ON public.rate_log
  IS 'Prevents more than one rating from the same user to the same target per 24 hours';
