-- Finalize an unpublished chat-media upload against account deletion.
-- Storage commits the object before its successful upload response. The Edge
-- Function calls this RPC only after that response, before publishing the path.
CREATE FUNCTION public.finalize_chat_media_upload(p_user_id UUID, p_path TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_path IS NULL
    OR left(p_path, length(p_user_id::TEXT) + 1) <> p_user_id::TEXT || '/'
    OR p_path ~ '(^|/)\.{1,2}(/|$)' THEN
    RAISE EXCEPTION 'invalid_upload_path' USING ERRCODE = 'check_violation';
  END IF;

  -- Matches the FOR UPDATE lock taken by delete_account_preserving_groups.
  -- If deletion is in progress, wait for it to commit or roll back. A plain
  -- SELECT could still see the old user while the deletion is uncommitted.
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR KEY SHARE;
  IF NOT FOUND THEN
    INSERT INTO public.chat_media_cleanup_queue(path) VALUES (p_path)
    ON CONFLICT (path) DO NOTHING;
    RETURN false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.objects
    WHERE bucket_id = 'chat-media' AND name = p_path) THEN
    RAISE EXCEPTION 'attachment_not_found' USING ERRCODE = 'check_violation';
  END IF;
  -- If deletion begins after this RPC commits, its Storage enumeration will
  -- include the already committed object. Either ordering therefore queues it.
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_chat_media_upload(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_chat_media_upload(UUID, TEXT) TO service_role;
