-- Regression for migration 034. Local/staging only; every fixture rolls back.
-- Run with psql ON_ERROR_STOP=1, or npm run test:sql for isolated PostgreSQL.
BEGIN;
DO $$
DECLARE
  a UUID := gen_random_uuid();
  b UUID := gen_random_uuid();
  g UUID := gen_random_uuid();
  image_path TEXT := a::TEXT || '/test/empty-caption.png';
  violated_constraint TEXT;
BEGIN
  INSERT INTO public.users(id, "fullName", school, grade, nickname, status) VALUES
    (a, 'caption test ' || a, '__caption_test__' || a, '1', 'caption_' || a, 'approved'),
    (b, 'caption test ' || b, '__caption_test__' || a, '1', 'caption_' || b, 'approved');
  INSERT INTO public.chat_groups(id, name, school, type, "createdBy") VALUES
    (g, 'caption test', '__caption_test__' || a, 'private', a);
  INSERT INTO storage.objects(bucket_id, name) VALUES ('chat-media', image_path);

  -- Both send targets accept an image whose caption is the empty string.
  INSERT INTO public.messages("fromId", "toId", text, type, "attachmentPath")
    VALUES (a, b, '', 'image', image_path);
  INSERT INTO public.messages("fromId", "groupId", text, type, "attachmentPath")
    VALUES (a, g, '', 'image', image_path);
  IF (SELECT count(*) FROM public.messages WHERE "fromId" = a AND text = '') <> 2 THEN
    RAISE EXCEPTION 'empty-caption direct/group messages were not stored';
  END IF;

  -- Existing valid text messages and the maximum-size caption remain valid.
  INSERT INTO public.messages("fromId", "toId", text) VALUES (a, b, repeat('x', 4000));
  INSERT INTO public.messages("fromId", "groupId", text, type, "attachmentPath")
    VALUES (a, g, repeat('x', 4000), 'image', image_path);

  BEGIN
    INSERT INTO public.messages("fromId", "toId", text) VALUES (a, b, '');
    RAISE EXCEPTION 'empty text without an attachment was allowed';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'messages_content_check' THEN
      RAISE EXCEPTION 'empty content rejected by unexpected constraint: %', violated_constraint;
    END IF;
  END;

  BEGIN
    INSERT INTO public.messages("fromId", "groupId", text) VALUES (a, g, '   ');
    RAISE EXCEPTION 'whitespace text without an attachment was allowed';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'messages_content_check' THEN
      RAISE EXCEPTION 'blank content rejected by unexpected constraint: %', violated_constraint;
    END IF;
  END;

  BEGIN
    INSERT INTO public.messages("fromId", "toId", text) VALUES (a, b, repeat('x', 4001));
    RAISE EXCEPTION 'text above 4000 characters was allowed';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'messages_text_check' THEN
      RAISE EXCEPTION 'long text rejected by unexpected constraint: %', violated_constraint;
    END IF;
  END;

  BEGIN
    INSERT INTO public.messages("fromId", "groupId", text, type, "attachmentPath")
      VALUES (a, g, repeat('x', 4001), 'image', image_path);
    RAISE EXCEPTION 'caption above 4000 characters was allowed';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'messages_text_check' THEN
      RAISE EXCEPTION 'long caption rejected by unexpected constraint: %', violated_constraint;
    END IF;
  END;

  BEGIN
    INSERT INTO public.messages("fromId", "toId", text) VALUES (a, b, NULL);
    RAISE EXCEPTION 'null message text was allowed';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
END;
$$;
ROLLBACK;
