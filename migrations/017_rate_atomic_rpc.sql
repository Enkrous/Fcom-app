-- Migration 017: Atomic rate_and_apply RPC
--
-- Combines INSERT into rate_log and cred UPDATE in a single PL/pgSQL
-- transaction, eliminating the race window that would exist if the two
-- operations were issued as separate Supabase calls from the Edge Function.
--
-- The enforce_rate_cooldown trigger (migration 012) fires inside the INSERT,
-- so DB-level 24h enforcement also happens within the same transaction.
--
-- Run AFTER migrations 005, 008, 012.

CREATE OR REPLACE FUNCTION public.rate_and_apply(
  p_from_id         UUID,
  p_to_id           UUID,
  p_score           INTEGER,
  p_weight          NUMERIC,
  p_base_delta      NUMERIC,
  p_effective_delta NUMERIC
)
RETURNS NUMERIC   -- new cred value of the rated user
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_cred NUMERIC;
BEGIN
  -- 1. Insert audit entry.
  --    The BEFORE INSERT trigger enforce_rate_cooldown fires here and will
  --    raise an exception (SQLSTATE 23505) if the 24h window is violated,
  --    rolling back the entire transaction automatically.
  INSERT INTO public.rate_log (
    "from", "to", score, weight, "baseDelta", "effectiveDelta"
  ) VALUES (
    p_from_id, p_to_id, p_score, p_weight, p_base_delta, p_effective_delta
  );

  -- 2. Update cred atomically in the same transaction.
  --    cred is floored at 0; rounded to 2 decimal places (mirrors credo.js).
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

-- Only service_role (used by Edge Functions) may execute this function.
REVOKE ALL ON FUNCTION public.rate_and_apply(UUID, UUID, INTEGER, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;

COMMENT ON FUNCTION public.rate_and_apply IS
  'Atomically inserts a rate_log entry and updates target user cred in one '
  'transaction. The enforce_rate_cooldown trigger fires during the INSERT, '
  'providing DB-level 24h cooldown enforcement. Called exclusively by the '
  '/rate Edge Function via service_role.';
