-- Isolated test records are rolled back; safe to run after migration 033.
BEGIN;
DO $$
DECLARE
  v_key_a text := 'reports:test-' || gen_random_uuid()::text;
  v_key_b text := 'reports:test-' || gen_random_uuid()::text;
BEGIN
  FOR i IN 1..5 LOOP
    IF NOT public.consume_rate_limit(v_key_a, 5, 3600000) THEN
      RAISE EXCEPTION 'report quota denied request % before five', i;
    END IF;
  END LOOP;
  IF public.consume_rate_limit(v_key_a, 5, 3600000) THEN
    RAISE EXCEPTION 'sixth report request allowed';
  END IF;
  IF NOT public.consume_rate_limit(v_key_b, 5, 3600000) THEN
    RAISE EXCEPTION 'different user shares exhausted quota';
  END IF;
  UPDATE public.rate_limit_log SET "createdAt" = now() - interval '61 minutes' WHERE key = v_key_a;
  IF NOT public.consume_rate_limit(v_key_a, 5, 3600000) THEN
    RAISE EXCEPTION 'expired report window still denied';
  END IF;
  IF has_function_privilege('anon', 'public.consume_rate_limit(text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.consume_rate_limit(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'client can execute rate-limit RPC';
  END IF;
END;
$$;
ROLLBACK;
