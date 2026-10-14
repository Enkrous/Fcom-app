-- Local/staging registration and pruning checks. All fixtures roll back.
BEGIN;
DO $$
DECLARE
  a UUID := gen_random_uuid(); b UUID := gen_random_uuid();
  v_token TEXT := replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', '');
  v_first TIMESTAMPTZ; v_second TIMESTAMPTZ; v_created TIMESTAMPTZ;
  v_first_registration UUID; v_second_registration UUID;
  v_invalid_blocked BOOLEAN := false;
BEGIN
  INSERT INTO public.users(id, "fullName", school, grade, nickname, status) VALUES
    (a, 'push test ' || a, '__push_test__', '1', 'push_' || a, 'pending'),
    (b, 'push test ' || b, '__push_test__', '1', 'push_' || b, 'approved');
  INSERT INTO public.device_tokens("userId", token, platform, environment) VALUES (a, v_token, 'ios', 'production');
  SELECT "createdAt", "updatedAt", "registrationId" INTO v_created, v_first, v_first_registration FROM public.device_tokens
  WHERE token = v_token AND environment = 'production';
  INSERT INTO public.device_tokens("userId", token, platform, environment) VALUES (b, v_token, 'ios', 'production')
  ON CONFLICT (platform, environment, token) DO UPDATE SET "userId" = excluded."userId";
  SELECT "updatedAt", "registrationId" INTO v_second, v_second_registration FROM public.device_tokens WHERE token = v_token AND environment = 'production';
  IF v_second < v_first OR v_first_registration = v_second_registration THEN
    RAISE EXCEPTION 'registration version not refreshed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.device_tokens WHERE token = v_token
    AND environment = 'production' AND "userId" = b AND "createdAt" = v_created) THEN
    RAISE EXCEPTION 'token owner not reassigned or creation time changed';
  END IF;
  DELETE FROM public.device_tokens WHERE token = v_token AND environment = 'production'
    AND "userId" = a AND "updatedAt" = v_first;
  DELETE FROM public.device_tokens WHERE token = v_token AND environment = 'production'
    AND "userId" = b AND "registrationId" = v_first_registration;
  DELETE FROM public.device_tokens WHERE token = v_token AND environment = 'production'
    AND "userId" = b AND "updatedAt" = v_second AND "updatedAt" < v_first;
  IF NOT EXISTS (SELECT 1 FROM public.device_tokens WHERE token = v_token AND environment = 'production') THEN
    RAISE EXCEPTION 'stale APNs response removed a new registration';
  END IF;
  INSERT INTO public.device_tokens("userId", token, platform, environment) VALUES (a, v_token, 'ios', 'sandbox');
  IF (SELECT count(*) FROM public.device_tokens WHERE token = v_token) <> 2 THEN
    RAISE EXCEPTION 'sandbox and production tokens not isolated';
  END IF;
  BEGIN
    INSERT INTO public.device_tokens("userId", token, platform) VALUES (a, 'not-an-apns-token', 'ios');
  EXCEPTION WHEN check_violation THEN v_invalid_blocked := true;
  END;
  IF NOT v_invalid_blocked THEN RAISE EXCEPTION 'invalid APNs token accepted'; END IF;
  -- Apple does not promise the common 32-byte token size.
  INSERT INTO public.device_tokens("userId", token, platform, environment)
  VALUES (a, repeat('b', 128), 'ios', 'sandbox');
  IF NOT EXISTS (SELECT 1 FROM public.device_tokens WHERE token = repeat('b', 128) AND "userId" = a) THEN
    RAISE EXCEPTION 'variable-length APNs token was rejected';
  END IF;
  BEGIN
    INSERT INTO public.device_tokens("userId", token, platform) VALUES (a, repeat('b', 127), 'ios');
    RAISE EXCEPTION 'partial-byte APNs token accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM public.users WHERE id = b;
  IF EXISTS (SELECT 1 FROM public.device_tokens WHERE "userId" = b) THEN
    RAISE EXCEPTION 'account deletion retained device tokens';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.device_tokens WHERE "userId" = a AND environment = 'sandbox') THEN
    RAISE EXCEPTION 'account deletion removed another account token';
  END IF;
END;
$$;
ROLLBACK;
