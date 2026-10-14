-- Local/staging only. Rollback fixtures verify both linearization orderings;
-- PGlite executes one backend, so this is not a multi-connection lock stress test.
BEGIN;
DO $$
DECLARE
  v_live UUID := gen_random_uuid();
  v_late UUID := gen_random_uuid();
  v_live_path TEXT;
  v_late_path TEXT;
BEGIN
  v_live_path := v_live::TEXT || '/test/finalized.png';
  v_late_path := v_late::TEXT || '/test/late.png';
  INSERT INTO public.users(id, "fullName", school, grade, nickname, status)
  VALUES (v_live, 'upload test ' || v_live, '__upload_test__', '1', 'upload_' || v_live, 'approved'),
    (v_late, 'upload test ' || v_late, '__upload_test__', '1', 'upload_' || v_late, 'approved');

  -- Upload commits before finalization; if deletion happens afterwards its
  -- enumeration sees this object and records durable cleanup.
  INSERT INTO storage.objects(bucket_id, name) VALUES ('chat-media', v_live_path);
  IF public.finalize_chat_media_upload(v_live, v_live_path) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'committed upload for a live user must finalize';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = v_live_path) THEN
    RAISE EXCEPTION 'live upload must not be queued';
  END IF;
  PERFORM public.delete_account_preserving_groups(v_live);
  IF NOT EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = v_live_path) THEN
    RAISE EXCEPTION 'deletion after finalization must queue the committed upload';
  END IF;

  -- Deletion enumerates Storage and commits first; upload metadata arrives
  -- later. This was the previously unqueued orphan scenario.
  PERFORM public.delete_account_preserving_groups(v_late);
  INSERT INTO storage.objects(bucket_id, name) VALUES ('chat-media', v_late_path);
  IF public.finalize_chat_media_upload(v_late, v_late_path) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'late upload must not finalize for a deleted account';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = v_late_path) THEN
    RAISE EXCEPTION 'late upload must be queued for retry';
  END IF;
  -- Repeated finalization is safe and the private queue remains one row/path.
  PERFORM public.finalize_chat_media_upload(v_late, v_late_path);
  IF (SELECT COUNT(*) FROM public.chat_media_cleanup_queue WHERE path = v_late_path) <> 1 THEN
    RAISE EXCEPTION 'late-upload queue insertion must be idempotent';
  END IF;

  BEGIN
    PERFORM public.finalize_chat_media_upload(v_late, v_live_path);
    RAISE EXCEPTION 'cross-owner cleanup path must be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.finalize_chat_media_upload(v_late, v_late::TEXT || '/../other.png');
    RAISE EXCEPTION 'traversal cleanup path must be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.finalize_chat_media_upload(uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.finalize_chat_media_upload(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'upload finalization RPC must remain service-only';
  END IF;
  RAISE NOTICE 'Media finalization checks passed: both orderings, queue idempotency, scoped paths and service-only RPC.';
END;
$$;
ROLLBACK;
