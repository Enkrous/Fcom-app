-- Migration 002: Create otp_codes table

CREATE TABLE IF NOT EXISTS public.otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"    UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  code        TEXT NOT NULL,          -- 6-digit string
  "expiresAt" TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookup during verification
CREATE INDEX IF NOT EXISTS otp_codes_user_id_idx ON public.otp_codes ("userId");
CREATE INDEX IF NOT EXISTS otp_codes_phone_idx   ON public.otp_codes (phone);

-- Rate-limit helper: count recent OTPs per phone
CREATE INDEX IF NOT EXISTS otp_codes_phone_created_idx
  ON public.otp_codes (phone, "createdAt");

COMMENT ON TABLE public.otp_codes IS 'One-time passwords for phone verification';
COMMENT ON COLUMN public.otp_codes.code IS '6-digit OTP, TTL = 5 minutes';
