-- Migration 015: Add attempts counter to otp_codes
--
-- Adds an `attempts` column that counts failed verification tries per OTP.
-- When attempts >= 5 the OTP is treated as invalid (brute-force protection).
-- The verify-phone Edge Function increments this on every wrong code and
-- hard-invalidates (sets used = true) once the cap is reached.
--
-- Run AFTER migration 002.

ALTER TABLE public.otp_codes
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.otp_codes.attempts
  IS 'Failed verification attempts; OTP is invalidated when attempts >= 5';

-- Index to speed up the "find latest valid OTP" query used by verify-phone:
--   WHERE phone = $1 AND used = false AND "expiresAt" > now() AND attempts < 5
--   ORDER BY "createdAt" DESC LIMIT 1
CREATE INDEX IF NOT EXISTS otp_codes_valid_lookup_idx
  ON public.otp_codes (phone, "expiresAt", attempts)
  WHERE used = false;
