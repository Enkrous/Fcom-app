-- Migration 013: Approval / rejection audit log
--
-- Records every approve and reject action:
--   - who performed the action (actorId)
--   - who was the subject (targetId)
--   - what action was taken ('approved' | 'rejected')
--   - when it happened
--
-- This table is append-only (no UPDATE/DELETE via PostgREST).
-- Used for audit trails, analytics, and anti-abuse investigation.
--
-- Run AFTER migration 001.

CREATE TABLE IF NOT EXISTS public.approval_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "actorId"  UUID        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  "targetId" UUID        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  action     TEXT        NOT NULL CHECK (action IN ('approved', 'rejected')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- An actor should not act on themselves
  CONSTRAINT approval_log_no_self_action CHECK ("actorId" <> "targetId")
);

-- Fast lookup: all actions by a given actor
CREATE INDEX IF NOT EXISTS approval_log_actor_idx
  ON public.approval_log ("actorId", "createdAt" DESC);

-- Fast lookup: full history for a given target
CREATE INDEX IF NOT EXISTS approval_log_target_idx
  ON public.approval_log ("targetId", "createdAt" DESC);

-- Combined index for checking if actor already acted on target
CREATE INDEX IF NOT EXISTS approval_log_actor_target_idx
  ON public.approval_log ("actorId", "targetId");

-- RLS: visible only to participants and service_role
ALTER TABLE public.approval_log ENABLE ROW LEVEL SECURITY;

-- A user can see their own incoming decisions and the decisions they made
CREATE POLICY "approval_log_select_participant"
  ON public.approval_log FOR SELECT
  USING ("actorId" = auth.uid() OR "targetId" = auth.uid());

-- No direct INSERT/UPDATE/DELETE via PostgREST — written by approve/reject Edge Functions
COMMENT ON TABLE public.approval_log
  IS 'Audit log of every approve/reject decision; append-only';
COMMENT ON COLUMN public.approval_log."actorId"
  IS 'Approved user who performed the action';
COMMENT ON COLUMN public.approval_log."targetId"
  IS 'User who was approved or rejected';
COMMENT ON COLUMN public.approval_log.action
  IS 'approved | rejected';

-- ── Trigger: auto-write log entry on users.status change ─────────────────────
-- When the approve or reject Edge Function updates users.status, this trigger
-- records the actor from the session variable "app.actor_id" if set.
-- (The Edge Function sets this via: SET LOCAL "app.actor_id" = '<uuid>')
-- If not set (e.g. auto-approve trigger), actorId falls back to targetId.

CREATE OR REPLACE FUNCTION public.log_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor UUID;
BEGIN
  -- Only fire on status transitions to approved/rejected
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  -- Read actor set by the Edge Function; fall back to the target itself
  -- (covers the auto_approve_first trigger case)
  BEGIN
    actor := current_setting('app.actor_id', true)::UUID;
  EXCEPTION WHEN others THEN
    actor := NEW.id;
  END;
  IF actor IS NULL THEN
    actor := NEW.id;
  END IF;

  INSERT INTO public.approval_log ("actorId", "targetId", action)
  VALUES (actor, NEW.id, NEW.status);

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_status_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_log_status_change ON public.users;
CREATE TRIGGER trg_log_status_change
  AFTER UPDATE OF status ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.log_status_change();

COMMENT ON TRIGGER trg_log_status_change ON public.users
  IS 'Appends a row to approval_log whenever a user status changes to approved/rejected';
