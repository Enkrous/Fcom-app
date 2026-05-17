DO $$
DECLARE
  canonical_school TEXT := U&'\0424\0438\0437\0442\0435\0445';
  target_group_id UUID;
BEGIN
  SELECT cg.id
    INTO target_group_id
  FROM public.chat_groups AS cg
  WHERE cg.type = 'school_public'
    AND (
      lower(regexp_replace(btrim(coalesce(cg.school, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school))
      OR lower(regexp_replace(btrim(coalesce(cg.name, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school))
    )
  ORDER BY
    CASE
      WHEN cg.school = canonical_school THEN 0
      ELSE 1
    END,
    cg."createdAt" ASC,
    cg.id ASC
  LIMIT 1;

  IF target_group_id IS NOT NULL THEN
    UPDATE public.chat_groups
       SET name = canonical_school,
           school = canonical_school
     WHERE id = target_group_id;

    INSERT INTO public.group_members ("groupId", "userId", role, "addedBy", "joinedAt")
    SELECT target_group_id, gm."userId", gm.role, gm."addedBy", gm."joinedAt"
    FROM public.group_members AS gm
    JOIN public.chat_groups AS cg
      ON cg.id = gm."groupId"
    WHERE cg.type = 'school_public'
      AND cg.id <> target_group_id
      AND lower(regexp_replace(btrim(coalesce(cg.school, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school))
    ON CONFLICT ("groupId", "userId") DO NOTHING;

    INSERT INTO public.group_invites (id, "groupId", "invitedUserId", "invitedBy", status, "createdAt", "respondedAt")
    SELECT gi.id, target_group_id, gi."invitedUserId", gi."invitedBy", gi.status, gi."createdAt", gi."respondedAt"
    FROM public.group_invites AS gi
    JOIN public.chat_groups AS cg
      ON cg.id = gi."groupId"
    WHERE cg.type = 'school_public'
      AND cg.id <> target_group_id
      AND lower(regexp_replace(btrim(coalesce(cg.school, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school))
    ON CONFLICT ("groupId", "invitedUserId") DO NOTHING;

    UPDATE public.messages
       SET "groupId" = target_group_id
     WHERE "groupId" IN (
       SELECT cg.id
       FROM public.chat_groups AS cg
       WHERE cg.type = 'school_public'
         AND cg.id <> target_group_id
         AND lower(regexp_replace(btrim(coalesce(cg.school, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school))
     );

    DELETE FROM public.chat_groups
     WHERE type = 'school_public'
       AND id <> target_group_id
       AND lower(regexp_replace(btrim(coalesce(school, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school));
  END IF;

  UPDATE public.users
     SET school = canonical_school
   WHERE lower(regexp_replace(btrim(coalesce(school, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school));

  UPDATE public.chat_groups
     SET school = canonical_school
   WHERE type <> 'school_public'
     AND lower(regexp_replace(btrim(coalesce(school, '')), '\s+', ' ', 'g')) IN ('fiztex', 'phystech', lower(canonical_school));
END $$;
