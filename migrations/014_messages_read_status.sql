-- Migration 014: Add read status to messages
--
-- Adds a nullable "readAt" timestamp to the messages table.
-- NULL  = message has not been read by the recipient.
-- value = UTC timestamp when the recipient first opened the message.
--
-- This is a non-destructive ALTER TABLE — existing rows keep readAt = NULL.
-- Run AFTER migration 004.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.messages."readAt"
  IS 'NULL = unread; timestamp = when the recipient first read the message';

-- Index for "unread count" queries: all unread messages addressed to a user
CREATE INDEX IF NOT EXISTS messages_unread_idx
  ON public.messages ("toId", "readAt")
  WHERE "readAt" IS NULL;

-- ── Function: mark_messages_read ──────────────────────────────────────────────
-- Marks all messages in a conversation as read by the recipient.
-- Call from the messages Edge Function when the recipient opens a chat.
--
-- Parameters:
--   reader_id  — UUID of the user reading the messages (must equal toId)
--   sender_id  — UUID of the other conversation participant
--
-- Returns the count of messages that were newly marked as read.

CREATE OR REPLACE FUNCTION public.mark_messages_read(
  reader_id UUID,
  sender_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated INTEGER;
BEGIN
  UPDATE public.messages
  SET "readAt" = now()
  WHERE "toId"   = reader_id
    AND "fromId" = sender_id
    AND "readAt" IS NULL;

  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_messages_read(UUID, UUID) FROM PUBLIC;

COMMENT ON FUNCTION public.mark_messages_read(UUID, UUID)
  IS 'Marks all unread messages from sender_id to reader_id as read; returns count updated';
