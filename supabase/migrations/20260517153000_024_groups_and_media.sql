CREATE TABLE IF NOT EXISTS public.chat_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  school TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('private', 'school_public')),
  "createdBy" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  "avatarUrl" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_groups_school_public_idx
  ON public.chat_groups (LOWER(school))
  WHERE type = 'school_public';

CREATE INDEX IF NOT EXISTS chat_groups_school_idx
  ON public.chat_groups (school);

CREATE TABLE IF NOT EXISTS public.group_members (
  "groupId" UUID NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  "addedBy" UUID REFERENCES public.users(id) ON DELETE SET NULL,
  "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("groupId", "userId")
);

CREATE INDEX IF NOT EXISTS group_members_user_idx
  ON public.group_members ("userId");

CREATE TABLE IF NOT EXISTS public.group_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "groupId" UUID NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE,
  "invitedUserId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  "invitedBy" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "respondedAt" TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS group_invites_group_user_idx
  ON public.group_invites ("groupId", "invitedUserId");

CREATE INDEX IF NOT EXISTS group_invites_user_status_idx
  ON public.group_invites ("invitedUserId", status);

ALTER TABLE public.messages
  ALTER COLUMN "toId" DROP NOT NULL;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "groupId" UUID REFERENCES public.chat_groups(id) ON DELETE CASCADE;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'text';

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "attachmentPath" TEXT;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "attachmentMime" TEXT;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "attachmentBytes" INTEGER;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "attachmentWidth" INTEGER;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "attachmentHeight" INTEGER;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_type_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'image'));

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_target_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_target_check
  CHECK (
    (("toId" IS NOT NULL) AND ("groupId" IS NULL))
    OR
    (("toId" IS NULL) AND ("groupId" IS NOT NULL))
  );

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_content_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_content_check
  CHECK (
    COALESCE(NULLIF(BTRIM(text), ''), '') <> ''
    OR "attachmentPath" IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS messages_group_time_idx
  ON public.messages ("groupId", time DESC);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chat-media', 'chat-media', false, 6291456, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.chat_groups IS 'Closed private groups and per-school public groups for the messenger.';
COMMENT ON TABLE public.group_members IS 'Active group memberships.';
COMMENT ON TABLE public.group_invites IS 'Invite-only flow for private groups.';
COMMENT ON COLUMN public.messages."groupId" IS 'Nullable target for group messages; direct messages keep toId.';
COMMENT ON COLUMN public.messages."attachmentPath" IS 'Private Supabase Storage path for image attachments.';
