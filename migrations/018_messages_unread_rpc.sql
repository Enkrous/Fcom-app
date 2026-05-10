-- Migration 018: Unread message count helpers
--
-- Adds a single RPC that returns the number of unread messages per conversation
-- partner for a given user.  Calling this once on page load is more efficient
-- than one GET /messages call per partner just to count unread items.
--
-- Run AFTER migrations 004 and 014.

-- ── get_unread_counts ─────────────────────────────────────────────────────────
-- Returns a row per partner who has sent at least one unread message to userId.
--
-- Parameters:
--   p_user_id  — the recipient (person whose unread counts we want)
--
-- Returns rows of: (partner_id UUID, unread_count BIGINT)

CREATE OR REPLACE FUNCTION public.get_unread_counts(p_user_id UUID)
RETURNS TABLE (partner_id UUID, unread_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    "fromId"      AS partner_id,
    COUNT(*)      AS unread_count
  FROM public.messages
  WHERE "toId"   = p_user_id
    AND "readAt" IS NULL
  GROUP BY "fromId";
$$;

REVOKE ALL ON FUNCTION public.get_unread_counts(UUID) FROM PUBLIC;

COMMENT ON FUNCTION public.get_unread_counts IS
  'Returns (partner_id, unread_count) for every partner who has unread messages '
  'waiting for p_user_id. Called by the /users Edge Function to decorate the '
  'user list with unread badges in one DB round-trip.';

-- ── conversation_summary ──────────────────────────────────────────────────────
-- Returns the latest message and unread count for each conversation partner.
-- Useful for building a "chat list" view (like WhatsApp conversation list).
--
-- Parameters:
--   p_user_id  — the current user

CREATE OR REPLACE FUNCTION public.conversation_summary(p_user_id UUID)
RETURNS TABLE (
  partner_id   UUID,
  last_text    TEXT,
  last_time    TIMESTAMPTZ,
  last_from    UUID,
  unread_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH all_convos AS (
    SELECT
      CASE WHEN "fromId" = p_user_id THEN "toId" ELSE "fromId" END AS partner_id,
      text,
      time,
      "fromId",
      "readAt"
    FROM public.messages
    WHERE "fromId" = p_user_id OR "toId" = p_user_id
  ),
  latest AS (
    SELECT DISTINCT ON (partner_id)
      partner_id,
      text  AS last_text,
      time  AS last_time,
      "fromId" AS last_from
    FROM all_convos
    ORDER BY partner_id, time DESC
  ),
  unread AS (
    SELECT partner_id, COUNT(*) AS unread_count
    FROM all_convos
    WHERE "fromId" <> p_user_id   -- messages sent TO me
      AND "readAt" IS NULL
    GROUP BY partner_id
  )
  SELECT
    l.partner_id,
    l.last_text,
    l.last_time,
    l.last_from,
    COALESCE(u.unread_count, 0) AS unread_count
  FROM latest l
  LEFT JOIN unread u USING (partner_id)
  ORDER BY l.last_time DESC;
$$;

REVOKE ALL ON FUNCTION public.conversation_summary(UUID) FROM PUBLIC;

COMMENT ON FUNCTION public.conversation_summary IS
  'Returns one row per conversation partner: last message preview + unread count. '
  'Designed for building a chat list UI. Called exclusively via service_role.';
