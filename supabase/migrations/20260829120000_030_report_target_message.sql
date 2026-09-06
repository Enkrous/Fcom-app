-- Migration 030: optionally associate a report with a direct message.
-- The column is nullable so existing user-level reports remain valid.

ALTER TABLE public.user_reports
  ADD COLUMN IF NOT EXISTS "targetMessageId" UUID
  REFERENCES public.messages(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS user_reports_target_message_idx
  ON public.user_reports ("targetMessageId")
  WHERE "targetMessageId" IS NOT NULL;
