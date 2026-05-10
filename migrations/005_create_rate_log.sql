-- Migration 005: Create rate_log table
-- Mirrors the rating entry structure from credo.js

CREATE TABLE IF NOT EXISTS public.rate_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "from"          UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  "to"            UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  score           INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  weight          NUMERIC(6, 3) NOT NULL,
  "baseDelta"     NUMERIC(6, 2) NOT NULL,
  "effectiveDelta" NUMERIC(6, 2) NOT NULL,
  date            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for canRate check: from+to+date in last 24h
CREATE INDEX IF NOT EXISTS rate_log_from_to_date_idx
  ON public.rate_log ("from", "to", date);

-- Index for daily cred change calculation
CREATE INDEX IF NOT EXISTS rate_log_to_date_idx
  ON public.rate_log ("to", date);

-- Index for repeat-decay calculation (count timesRated)
CREATE INDEX IF NOT EXISTS rate_log_from_to_idx
  ON public.rate_log ("from", "to");

COMMENT ON TABLE public.rate_log IS 'Full audit log of all cred ratings — mirrors credo.js rateUser entries';
COMMENT ON COLUMN public.rate_log.weight IS 'credWeight * repeatDecay';
COMMENT ON COLUMN public.rate_log."baseDelta" IS 'SCORE_DELTA[score] before weight';
COMMENT ON COLUMN public.rate_log."effectiveDelta" IS 'After weight and daily cap clamping';
