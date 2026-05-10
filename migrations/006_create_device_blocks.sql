-- Migration 006: Create device_blocks table
-- Stores fingerprints of blocked devices (mirrors credo_blocked in localStorage)

CREATE TABLE IF NOT EXISTS public.device_blocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_blocks_fingerprint_idx
  ON public.device_blocks (fingerprint);

COMMENT ON TABLE public.device_blocks IS 'Blocked device fingerprints — prevents re-registration after rejection';
COMMENT ON COLUMN public.device_blocks.fingerprint IS 'SHA-256 of navigator.userAgent + screen dimensions + timezone, sent by client';
