-- Migration 029: harden report abuse prevention.
-- Keep at most one open report per reporter -> target pair and cap free text.

CREATE UNIQUE INDEX IF NOT EXISTS user_reports_one_open_per_pair
  ON public.user_reports ("reporterId", "targetId")
  WHERE status = 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_reports_details_length'
      AND conrelid = 'public.user_reports'::regclass
  ) THEN
    ALTER TABLE public.user_reports
      ADD CONSTRAINT user_reports_details_length
      CHECK (char_length(details) <= 1000);
  END IF;
END $$;
