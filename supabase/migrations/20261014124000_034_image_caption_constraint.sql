-- Migration 034: allow images without captions while retaining the text limit.
-- The original inline constraint from migration 004 required 1..4000 text
-- characters, so migration 024's attachment alternative never enabled an empty
-- caption. messages_content_check remains authoritative for nonempty content.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_text_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_text_check
  CHECK (char_length(text) <= 4000);

COMMENT ON CONSTRAINT messages_text_check ON public.messages IS
  'Maximum message/caption length. Empty text is allowed only with an attachment by messages_content_check.';
