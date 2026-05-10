-- Migration 004: Create messages table
-- Field names mirror the frontend chat model

CREATE TABLE IF NOT EXISTS public.messages (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "fromId" UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  "toId"   UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  text     TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  time     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fetching conversation between two users
CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON public.messages ("fromId", "toId");

-- Index for reverse direction
CREATE INDEX IF NOT EXISTS messages_conversation_rev_idx
  ON public.messages ("toId", "fromId");

-- Chronological ordering
CREATE INDEX IF NOT EXISTS messages_time_idx ON public.messages (time);

COMMENT ON TABLE public.messages IS 'Chat messages between approved users';
