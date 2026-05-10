-- Migration 016: Atomic approve/reject RPCs with correct actor logging
--
-- Problem the previous Edge Functions had:
--   approve/index.ts and reject/index.ts did a direct UPDATE on users.status.
--   The trigger trg_log_status_change reads current_setting('app.actor_id') to
--   record WHO performed the action. Because SET LOCAL only works inside the
--   current transaction, and supabase-js issues each statement as its own
--   implicit transaction, the session variable was never set.
--   Result: approval_log.actorId always stored the TARGET's own ID, not the
--   caller's — making the audit log useless.
--
-- Fix:
--   Two SECURITY DEFINER stored procedures that:
--     1. set_config('app.actor_id', actor_id, true)  ← SET LOCAL in the same txn
--     2. UPDATE users SET status = ...               ← trigger fires, reads correct actor
--     3. (approve only) call apply_cred_delta()
--     4. (reject only) optionally block device fingerprint
--
-- Both functions are callable by service_role via supabase.rpc().
-- Run AFTER migrations 008 and 013.

-- ─────────────────────────────────────────────────────────────────────────────
-- approve_and_log
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- Expose actor to the trg_log_status_change trigger within this transaction
  PERFORM set_config('app.actor_id', p_actor_id::TEXT, true);

  -- Update status → trigger fires → approval_log gets the correct actorId
  UPDATE public.users
  SET status = 'approved'
  WHERE id = p_target_id;

  -- Apply starting cred = 1 via the protected cred function
  SELECT public.apply_cred_delta(p_target_id, 1::NUMERIC) INTO v_new_cred;

  RETURN QUERY SELECT p_target_id, 'approved'::TEXT, v_new_cred;
END;
$$;

COMMENT ON FUNCTION public.approve_and_log(UUID, UUID)
  IS 'Atomically approves a user, applies initial cred = 1, and records the actor in approval_log';

-- ─────────────────────────────────────────────────────────────────────────────
-- reject_and_log
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- Expose actor to the trg_log_status_change trigger within this transaction
  PERFORM set_config('app.actor_id', p_actor_id::TEXT, true);

  -- Update status → trigger fires → approval_log gets the correct actorId
  UPDATE public.users
  SET status = 'rejected'
  WHERE id = p_target_id;

  -- Optionally block the device fingerprint
  IF p_fingerprint IS NOT NULL AND trim(p_fingerprint) <> '' THEN
    INSERT INTO public.device_blocks (fingerprint)
    VALUES (trim(p_fingerprint))
    ON CONFLICT (fingerprint) DO NOTHING;
  END IF;

  RETURN QUERY SELECT p_target_id, 'rejected'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.reject_and_log(UUID, UUID, TEXT)
  IS 'Atomically rejects a user, optionally blocks their device fingerprint, and records the actor in approval_log';
