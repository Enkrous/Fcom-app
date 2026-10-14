-- Transactional deletion regression suite. Run on a local/staging database only.
-- All fixtures, guard tables and deletions are rolled back; never use seed.sql
-- against production. psql must use ON_ERROR_STOP=1 so assertion failures fail CI.
BEGIN;
DO $$
DECLARE
  a UUID := gen_random_uuid(); b UUID := gen_random_uuid(); c UUID := gen_random_uuid();
  g UUID := gen_random_uuid(); empty_g UUID := gen_random_uuid(); school_g UUID := gen_random_uuid();
  empty_school UUID := gen_random_uuid(); other_g UUID := gen_random_uuid();
  group_message UUID := gen_random_uuid(); other_message UUID := gen_random_uuid();
  group_path TEXT; direct_path TEXT; inbound_path TEXT; empty_path TEXT;
  guard_table TEXT := 'fcom_delete_guard_' || replace(gen_random_uuid()::TEXT, '-', '');
  result UUID;
BEGIN
  group_path := a::TEXT || '/test/preserved.png';
  direct_path := a::TEXT || '/test/direct.png';
  inbound_path := b::TEXT || '/test/inbound.png';
  empty_path := a::TEXT || '/test/empty.png';
  INSERT INTO public.users(id, "fullName", school, grade, nickname, status)
  VALUES (a, 'delete test ' || a, '__delete_test__' || a, '1', 'delete_' || a, 'approved'),
         (b, 'delete test ' || b, '__delete_test__' || a, '1', 'delete_' || b, 'approved'),
         (c, 'delete test ' || c, '__delete_test__' || a, '1', 'delete_' || c, 'approved');
  INSERT INTO public.chat_groups(id, name, school, type, "createdBy") VALUES
    (g, 'surviving private', '__delete_test__' || a, 'private', a),
    (empty_g, 'empty private', '__delete_test__' || a, 'private', a),
    (school_g, 'surviving school', '__delete_test__' || a, 'school_public', a),
    (empty_school, 'empty school', '__delete_empty__' || a, 'school_public', a),
    (other_g, 'last admin but not creator', '__delete_test__' || a, 'private', c);
  INSERT INTO public.group_members("groupId", "userId", role, "addedBy", "joinedAt") VALUES
    (g, a, 'admin', a, '2020-01-01'), (g, b, 'member', a, '2020-01-02'), (g, c, 'admin', a, '2020-01-03'),
    (empty_g, a, 'admin', a, '2020-01-01'),
    (school_g, a, 'admin', a, '2020-01-01'), (school_g, b, 'member', a, '2020-01-02'),
    (empty_school, a, 'admin', a, '2020-01-01'),
    (other_g, a, 'admin', a, '2020-01-01'), (other_g, c, 'member', a, '2020-01-02');
  -- Metadata-only fixtures; no blob uploads. All roll back with this transaction.
  INSERT INTO storage.objects(bucket_id, name) VALUES
    ('chat-media', group_path), ('chat-media', direct_path),
    ('chat-media', inbound_path), ('chat-media', empty_path),
    ('chat-media', a::TEXT || '/test/unused.png');
  INSERT INTO public.messages(id, "fromId", "groupId", text, type, "attachmentPath") VALUES
    (group_message, a, g, 'preserve outgoing group message', 'image', group_path),
    (other_message, b, g, 'preserve other member message', 'text', NULL),
    (gen_random_uuid(), a, empty_g, 'empty-group media removed', 'image', empty_path);
  INSERT INTO public.messages("fromId", "toId", text, type, "attachmentPath") VALUES
    (a, b, 'erase direct outgoing', 'image', direct_path),
    (b, a, 'erase direct incoming', 'image', inbound_path),
    (a, c, 'direct shares live group attachment', 'image', group_path);
  INSERT INTO public.sessions("userId", jti, "expiresAt") VALUES (a, gen_random_uuid(), now() + INTERVAL '1 day');
  INSERT INTO public.otp_codes("userId", phone, code, "expiresAt") VALUES (a, '+00000000001', '123456', now() + INTERVAL '1 hour');
  INSERT INTO public.user_blocks("blockerId", "blockedId") VALUES (a, b), (c, a);
  INSERT INTO public.user_reports("reporterId", "targetId", reason) VALUES (a, b, 'spam'), (c, a, 'other');
  INSERT INTO public.group_invites("groupId", "invitedUserId", "invitedBy") VALUES (g, c, a);
  INSERT INTO public.rate_log("from", "to", score, weight, "baseDelta", "effectiveDelta") VALUES (a, b, 3, 1, 0, 0);
  INSERT INTO public.approval_log("actorId", "targetId", action) VALUES (a, b, 'approved');

  -- Deliberately block the final DELETE to verify every preceding change rolls
  -- back, including owner transfer, message tombstones and queued storage paths.
  EXECUTE format('CREATE TABLE public.%I (user_id UUID REFERENCES public.users(id) ON DELETE RESTRICT)', guard_table);
  EXECUTE format('INSERT INTO public.%I VALUES ($1)', guard_table) USING a;
  BEGIN
    PERFORM public.delete_account_preserving_groups(a);
    RAISE EXCEPTION 'expected foreign_key_violation did not occur';
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = a)
    OR NOT EXISTS (SELECT 1 FROM public.chat_groups WHERE id = g AND "createdBy" = a)
    OR NOT EXISTS (SELECT 1 FROM public.messages WHERE id = group_message AND "fromId" = a AND "deletedFromId" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.sessions WHERE "userId" = a)
    OR EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path IN (direct_path, inbound_path, empty_path)) THEN
    RAISE EXCEPTION 'deletion failure was not atomic';
  END IF;
  EXECUTE format('DROP TABLE public.%I', guard_table);

  result := public.delete_account_preserving_groups(a);
  IF result IS DISTINCT FROM a OR EXISTS (SELECT 1 FROM public.users WHERE id = a) THEN
    RAISE EXCEPTION 'account was not deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_groups WHERE id = g AND "createdBy" = b)
    OR NOT EXISTS (SELECT 1 FROM public.group_members WHERE "groupId" = g AND "userId" = b AND role = 'admin') THEN
    RAISE EXCEPTION 'ownership must pass to oldest surviving member, even if another admin exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_groups WHERE id = school_g AND "createdBy" = b)
    OR NOT EXISTS (SELECT 1 FROM public.group_members WHERE "groupId" = other_g AND "userId" = c AND role = 'admin') THEN
    RAISE EXCEPTION 'school ownership / non-owner departing admin handoff failed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chat_groups WHERE id IN (empty_g, empty_school)) THEN
    RAISE EXCEPTION 'groups without remaining participants must be deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE id = group_message AND "fromId" IS NULL
      AND "deletedFromId" = a AND text = 'preserve outgoing group message' AND "attachmentPath" = group_path)
    OR NOT EXISTS (SELECT 1 FROM public.messages WHERE id = other_message AND "fromId" = b AND "deletedFromId" IS NULL) THEN
    RAISE EXCEPTION 'surviving group history or attachment metadata was lost';
  END IF;
  IF EXISTS (SELECT 1 FROM public.messages WHERE "groupId" IS NULL AND ("fromId" = a OR "toId" = a)) THEN
    RAISE EXCEPTION 'direct messages involving deleted user must be erased';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sessions WHERE "userId" = a)
    OR EXISTS (SELECT 1 FROM public.otp_codes WHERE "userId" = a)
    OR EXISTS (SELECT 1 FROM public.group_members WHERE "userId" = a)
    OR EXISTS (SELECT 1 FROM public.group_invites WHERE "invitedBy" = a OR "invitedUserId" = a)
    OR EXISTS (SELECT 1 FROM public.user_blocks WHERE "blockerId" = a OR "blockedId" = a)
    OR EXISTS (SELECT 1 FROM public.user_reports WHERE "reporterId" = a OR "targetId" = a)
    OR EXISTS (SELECT 1 FROM public.rate_log WHERE "from" = a OR "to" = a)
    OR EXISTS (SELECT 1 FROM public.approval_log WHERE "actorId" = a OR "targetId" = a) THEN
    RAISE EXCEPTION 'personal data/session cascade incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = direct_path)
    OR NOT EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = inbound_path)
    OR NOT EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = empty_path)
    OR NOT EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = a::TEXT || '/test/unused.png')
    OR EXISTS (SELECT 1 FROM public.chat_media_cleanup_queue WHERE path = group_path) THEN
    RAISE EXCEPTION 'storage queue must include orphaned direct and empty-group media, excluding live group media';
  END IF;
  -- A surviving uploader cannot reuse a path between the cleanup reference
  -- check and physical Storage removal. Missing objects cannot be reused later.
  BEGIN
    INSERT INTO public.messages("fromId", "toId", text, type, "attachmentPath")
    VALUES (b, c, 'cannot restore queued attachment', 'image', inbound_path);
    RAISE EXCEPTION 'queued attachment was allowed to become live';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.messages("fromId", "toId", text, type, "attachmentPath")
    VALUES (b, c, 'missing object', 'image', b::TEXT || '/missing.png');
    RAISE EXCEPTION 'nonexistent attachment was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.referenced_chat_media(ARRAY[group_path, direct_path]) WHERE path = group_path)
    OR EXISTS (SELECT 1 FROM public.referenced_chat_media(ARRAY[group_path, direct_path]) WHERE path = direct_path) THEN
    RAISE EXCEPTION 'media reference RPC returned unsafe results';
  END IF;
  IF public.delete_account_preserving_groups(a) IS NOT NULL THEN
    RAISE EXCEPTION 'missing account must return NULL without touching other accounts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = b) OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = c) THEN
    RAISE EXCEPTION 'surviving members must retain their accounts';
  END IF;
  RAISE NOTICE 'Account deletion tests passed: atomic rollback, oldest-member handoff, admin replacement, school/private groups, tombstones, direct-message erase, revocation and safe media queue.';
END;
$$;
ROLLBACK;
