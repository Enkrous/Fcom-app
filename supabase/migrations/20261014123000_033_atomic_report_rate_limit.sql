-- Per-account report quota; serialize checks across Edge workers.
CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_key text, p_max integer, p_window_ms integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_count bigint;
BEGIN
  IF p_key IS NULL OR length(p_key) = 0 OR p_max <= 0 OR p_window_ms <= 0 THEN
    RAISE EXCEPTION 'invalid_rate_limit';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));
  v_now := clock_timestamp();
  SELECT count(*) INTO v_count FROM public.rate_limit_log
  WHERE key = p_key AND "createdAt" > v_now - p_window_ms * interval '1 millisecond';
  IF v_count >= p_max THEN RETURN false; END IF;
  INSERT INTO public.rate_limit_log (key, "createdAt") VALUES (p_key, v_now);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, integer, integer) TO service_role;
