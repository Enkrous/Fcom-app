-- APNs registration is accessed only by Edge Functions using service_role.
-- A device token has one current account owner per APNs environment. Register
-- again after switching accounts, and unregister before logout on the device.
CREATE TABLE public.device_tokens (
  "userId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL CHECK (token ~ '^[0-9a-f]{64}$'),
  platform TEXT NOT NULL DEFAULT 'ios' CHECK (platform = 'ios'),
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox', 'production')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "registrationId" UUID NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (platform, environment, token)
);

CREATE INDEX device_tokens_user_idx ON public.device_tokens ("userId", environment);

CREATE FUNCTION public.touch_device_token_registration()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW."updatedAt" := clock_timestamp();
  NEW."registrationId" := gen_random_uuid();
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_tokens_touch_registration
BEFORE INSERT OR UPDATE ON public.device_tokens
FOR EACH ROW EXECUTE FUNCTION public.touch_device_token_registration();

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.device_tokens TO service_role;
CREATE POLICY device_tokens_service_role_all ON public.device_tokens
FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON FUNCTION public.touch_device_token_registration() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_device_token_registration() TO service_role;

COMMENT ON TABLE public.device_tokens IS 'APNs tokens, one current owner per device/environment. Custom-JWT clients use register-push; service_role only.';
COMMENT ON COLUMN public.device_tokens."updatedAt" IS 'Server registration version. APNs invalidation removes only this exact owner/version, never a newer registration.';
COMMENT ON COLUMN public.device_tokens."registrationId" IS 'Refreshes on every registration; protects against stale APNs cleanup even when timestamps are equal.';
