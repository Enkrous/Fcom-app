-- Migration 031: atomic account deletion without destroying other members' history.
-- Apply before deploying delete-account. Direct messages are erased; messages in
-- surviving groups retain an opaque sender tombstone and their attachments.

ALTER TABLE public.chat_groups DROP CONSTRAINT IF EXISTS "chat_groups_createdBy_fkey";
ALTER TABLE public.chat_groups ADD CONSTRAINT "chat_groups_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE public.messages ALTER COLUMN "fromId" DROP NOT NULL;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS "deletedFromId" UUID;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS "messages_fromId_fkey";
ALTER TABLE public.messages ADD CONSTRAINT "messages_fromId_fkey"
  FOREIGN KEY ("fromId") REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_sender_check CHECK (
  ("fromId" IS NOT NULL AND "deletedFromId" IS NULL)
  OR ("fromId" IS NULL AND "groupId" IS NOT NULL AND "deletedFromId" IS NOT NULL)
);

COMMENT ON COLUMN public.messages."deletedFromId" IS
  'Opaque deleted sender UUID for surviving group history. No FK or user profile. Edge responses keep fromId:string and add senderDeleted:true.';
CREATE INDEX IF NOT EXISTS messages_attachment_path_idx ON public.messages("attachmentPath")
  WHERE "attachmentPath" IS NOT NULL;

-- Storage deletion cannot share a transaction with PostgreSQL. Record orphan
-- paths in the same transaction and retry them through the protected cleanup
-- endpoint. Never purge a deleted user's whole prefix: surviving group messages
-- may still reference their media.
CREATE TABLE IF NOT EXISTS public.chat_media_cleanup_queue (
  path TEXT PRIMARY KEY,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_media_cleanup_queue_created_idx
  ON public.chat_media_cleanup_queue("createdAt");
ALTER TABLE public.chat_media_cleanup_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_media_cleanup_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_media_cleanup_queue TO service_role;
DROP POLICY IF EXISTS chat_media_cleanup_queue_service_role_all ON public.chat_media_cleanup_queue;
CREATE POLICY chat_media_cleanup_queue_service_role_all ON public.chat_media_cleanup_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Once queued, an orphan cannot become a live attachment while Storage cleanup
-- is in flight. After cleanup acknowledges the queue, metadata must still exist
-- to attach a path. Account deletion locks messages before adding queue rows.
CREATE OR REPLACE FUNCTION public.guard_chat_media_attachment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."attachmentPath" IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = NEW."attachmentPath") THEN
    RAISE EXCEPTION 'attachment_pending_cleanup' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects
    WHERE bucket_id = 'chat-media' AND name = NEW."attachmentPath") THEN
    RAISE EXCEPTION 'attachment_not_found' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_chat_media_attachment() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_chat_media_attachment() TO service_role;
DROP TRIGGER IF EXISTS trg_guard_chat_media_attachment ON public.messages;
CREATE TRIGGER trg_guard_chat_media_attachment
  BEFORE INSERT OR UPDATE OF "attachmentPath" ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_media_attachment();

CREATE OR REPLACE FUNCTION public.delete_account_preserving_groups(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_group RECORD;
  v_successor UUID;
  v_paths TEXT[];
BEGIN
  -- Serialize membership changes, ownership changes and sends during the short
  -- deletion transaction. Deterministic lock order also serializes deletions.
  LOCK TABLE public.chat_groups, public.group_members, public.messages
    IN SHARE ROW EXCLUSIVE MODE;

  PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- A departing sole admin needs a replacement even when they no longer own
  -- the group. Ownership always follows the oldest surviving membership.
  FOR v_group IN
    SELECT g.id, g."createdBy"
    FROM public.chat_groups g
    WHERE g."createdBy" = p_user_id OR EXISTS (
      SELECT 1 FROM public.group_members m
      WHERE m."groupId" = g.id AND m."userId" = p_user_id
    )
    ORDER BY g.id
  LOOP
    SELECT m."userId" INTO v_successor
    FROM public.group_members m
    WHERE m."groupId" = v_group.id AND m."userId" <> p_user_id
    ORDER BY m."joinedAt", m."userId"
    LIMIT 1;

    IF v_successor IS NULL THEN
      SELECT array_agg(DISTINCT "attachmentPath") INTO v_paths
      FROM public.messages WHERE "groupId" = v_group.id AND "attachmentPath" IS NOT NULL;
      INSERT INTO public.chat_media_cleanup_queue(path)
      SELECT unnest(v_paths) ON CONFLICT (path) DO NOTHING;
      -- Empty school groups can be safely recreated by ensureSchoolPublicGroup.
      DELETE FROM public.chat_groups WHERE id = v_group.id;
    ELSE
      IF v_group."createdBy" = p_user_id THEN
        UPDATE public.chat_groups SET "createdBy" = v_successor WHERE id = v_group.id;
        UPDATE public.group_members SET role = 'admin'
        WHERE "groupId" = v_group.id AND "userId" = v_successor;
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.group_members
        WHERE "groupId" = v_group.id AND "userId" <> p_user_id AND role = 'admin'
      ) THEN
        UPDATE public.group_members SET role = 'admin'
        WHERE "groupId" = v_group.id AND "userId" = v_successor;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.chat_media_cleanup_queue(path)
  SELECT DISTINCT "attachmentPath" FROM public.messages
  WHERE "groupId" IS NULL AND ("fromId" = p_user_id OR "toId" = p_user_id)
    AND "attachmentPath" IS NOT NULL
  ON CONFLICT (path) DO NOTHING;

  DELETE FROM public.messages
  WHERE "groupId" IS NULL AND ("fromId" = p_user_id OR "toId" = p_user_id);

  UPDATE public.messages SET "deletedFromId" = p_user_id, "fromId" = NULL
  WHERE "groupId" IS NOT NULL AND "fromId" = p_user_id;

  -- Include unused uploads from Storage metadata (read only; Storage API does
  -- the actual deletion). Prefix matches include both date folders and files.
  INSERT INTO public.chat_media_cleanup_queue(path)
  SELECT name FROM storage.objects
  WHERE bucket_id = 'chat-media' AND name LIKE p_user_id::TEXT || '/%'
  ON CONFLICT (path) DO NOTHING;

  -- A direct attachment could also have been referenced by a surviving group
  -- message. Remove it from the queue, irrespective of who uploaded it.
  DELETE FROM public.chat_media_cleanup_queue q
  WHERE EXISTS (SELECT 1 FROM public.messages m WHERE m."attachmentPath" = q.path);

  -- CASCADE removes sessions, OTPs, ratings, memberships, invites, reports and
  -- blocks. A failure rolls back ownership, messages and the cleanup queue too.
  DELETE FROM public.users WHERE id = p_user_id;
  RETURN p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_account_preserving_groups(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_account_preserving_groups(UUID) TO service_role;

-- DISTINCT bounds this result by the <=100 queued paths, irrespective of the
-- number of messages referencing each path (PostgREST otherwise caps at 1000).
CREATE OR REPLACE FUNCTION public.referenced_chat_media(p_paths TEXT[])
RETURNS TABLE(path TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT m."attachmentPath" FROM public.messages m
  WHERE m."attachmentPath" = ANY(p_paths);
$$;
REVOKE ALL ON FUNCTION public.referenced_chat_media(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.referenced_chat_media(TEXT[]) TO service_role;
