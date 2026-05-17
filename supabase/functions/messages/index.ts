/**
 * Edge Function: /functions/v1/messages
 *
 * GET  ?partnerId=<uuid>[&limit=50][&before=<ISO-timestamp>]
 *   — Fetch conversation between caller and partner.
 *   — Auto-marks partner's messages to the caller as read.
 *   — Default (no limit/before): returns ALL messages ascending — backward compatible.
 *   — With limit: returns the most recent `limit` messages, ascending.
 *   — With limit + before: cursor pagination — messages older than `before`.
 *   — Response: { ok, messages, markedRead, hasMore }
 *
 * POST { toId, text }
 *   — Send a message.
 *   — Response: { ok, message }
 *
 * Both routes require: Authorization: Bearer <jwt>, caller status = 'approved'.
 * fromId is always taken from JWT — the body cannot spoof the sender.
 *
 * Read-status fields:
 *   readAt — NULL means unread by recipient; timestamp means first-read time.
 *   mark_messages_read() SQL RPC is called on GET so the recipient's view
 *   reflects reality as soon as they open the chat.
 */

import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { getGroupAccess }            from '../_shared/groups.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { rateLimitDb }               from '../_shared/ratelimit.ts';
import { isSameSchool }              from '../_shared/school.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPrelight();

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) return err('server_misconfigured', 500);

  const supabase = getServiceClient();

  let payload;
  try {
    payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
  } catch (e: unknown) {
    return err((e as Error).message ?? 'unauthorized', 401);
  }
  const myId = payload.sub;

  // Verify caller is approved
  const { data: caller } = await supabase
    .from('users')
    .select('id, school, role, status')
    .eq('id', myId)
    .maybeSingle();

  if (!caller)                      return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  // ── GET: fetch conversation ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url       = new URL(req.url);
    const partnerId = url.searchParams.get('partnerId')?.trim();
    const groupId   = url.searchParams.get('groupId')?.trim();
    const beforeRaw = url.searchParams.get('before');
    const limitRaw  = url.searchParams.get('limit');

    if (!partnerId && !groupId) return err('conversation_target_required');
    if (partnerId && groupId) return err('conversation_target_conflict');

    // Validate cursor timestamp
    let before: string | null = null;
    if (beforeRaw) {
      const d = new Date(beforeRaw);
      if (isNaN(d.getTime())) return err('invalid_before_cursor');
      before = d.toISOString();
    }

    // Parse limit — only applies when explicitly supplied
    const paginate = limitRaw !== null;
    const limit = paginate
      ? Math.min(
          Math.max(1, parseInt(limitRaw!, 10) || DEFAULT_LIMIT),
          MAX_LIMIT,
        )
      : null;

    if (groupId) {
      const access = await getGroupAccess(supabase, groupId, myId, caller.role, caller.school);
      if (!access.group || !access.canView) return err('group_not_found', 404);

      let query = supabase
        .from('messages')
        .select('id, "fromId", "toId", "groupId", type, text, time, "readAt", "attachmentPath", "attachmentMime", "attachmentBytes", "attachmentWidth", "attachmentHeight"')
        .eq('groupId', groupId);

      if (paginate) {
        query = query.order('time', { ascending: false }).limit(limit! + 1);
        if (before) query = query.lt('time', before);
      } else {
        query = query.order('time', { ascending: true });
      }

      const { data: rows, error: fetchErr } = await query;
      if (fetchErr) {
        console.error('group messages fetch error:', fetchErr);
        return err('fetch_failed', 500);
      }

      let messages: typeof rows;
      let hasMore = false;

      if (paginate) {
        hasMore = rows.length > limit!;
        messages = (hasMore ? rows.slice(0, limit!) : rows).reverse();
      } else {
        messages = rows;
      }

      return ok({
        messages: await withSignedAttachmentUrls(supabase, messages),
        markedRead: 0,
        hasMore,
      });
    }

    // Verify partner exists, approved, same school
    const { data: partner } = await supabase
      .from('users')
      .select('id, school, status')
      .eq('id', partnerId)
      .maybeSingle();

    if (!partner)                              return err('partner_not_found', 404);
    if (!isSameSchool(partner.school, caller.school)) return err('cross_school_forbidden', 403);
    if (partner.status !== 'approved')         return err('partner_not_approved');

    // Build conversation query
    let query = supabase
      .from('messages')
      .select('id, "fromId", "toId", "groupId", type, text, time, "readAt", "attachmentPath", "attachmentMime", "attachmentBytes", "attachmentWidth", "attachmentHeight"')
      .or(
        `and("fromId".eq.${myId},"toId".eq.${partnerId}),` +
        `and("fromId".eq.${partnerId},"toId".eq.${myId})`,
      );

    if (paginate) {
      // Cursor pagination: newest-first fetch so we can detect hasMore,
      // then reverse to return ascending order to the client.
      query = query.order('time', { ascending: false }).limit(limit! + 1);
      if (before) query = query.lt('time', before);
    } else {
      // Backward-compatible default: return all messages in ascending order.
      query = query.order('time', { ascending: true });
    }

    const { data: rows, error: fetchErr } = await query;

    if (fetchErr) {
      console.error('messages fetch error:', fetchErr);
      return err('fetch_failed', 500);
    }

    let messages: typeof rows;
    let hasMore = false;

    if (paginate) {
      hasMore  = rows.length > limit!;
      messages = (hasMore ? rows.slice(0, limit!) : rows).reverse();
    } else {
      messages = rows;
    }

    // Mark partner's messages to me as read (non-fatal if it fails)
    const { data: markedRead } = await supabase.rpc('mark_messages_read', {
      reader_id: myId,
      sender_id: partnerId,
    });

    return ok({
      messages: await withSignedAttachmentUrls(supabase, messages),
      markedRead: Number(markedRead ?? 0),
      hasMore,
    });
  }

  // ── POST: send a message ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    // Rate limit: 30 messages per IP per minute
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
    const allowed = await rateLimitDb(supabase, ip, 'messages', 30, 60_000);
    if (!allowed) return err('rate_limit_exceeded', 429);

    let body: {
      toId?: string;
      groupId?: string;
      text?: string;
      attachmentPath?: string;
      attachmentMime?: string;
      attachmentBytes?: number;
      attachmentWidth?: number;
      attachmentHeight?: number;
    };
    try {
      body = await req.json();
    } catch {
      return err('invalid_json');
    }

    const toId = body.toId?.trim();
    const groupId = body.groupId?.trim();
    const text = String(body.text ?? '').trim();
    const attachmentPath = body.attachmentPath?.trim();
    const hasAttachment = Boolean(attachmentPath);

    if (!toId && !groupId) return err('conversation_target_required');
    if (toId && groupId) return err('conversation_target_conflict');
    if (!text && !hasAttachment) return err('text_required');
    if (text.length > 4000) return err('text_too_long');
    if (toId && myId === toId) return err('cannot_message_self');

    if (groupId) {
      const access = await getGroupAccess(supabase, groupId, myId, caller.role, caller.school);
      if (!access.group || !access.memberRole) return err('group_not_found', 404);

      const { data: message, error: insertErr } = await supabase
        .from('messages')
        .insert({
          fromId: myId,
          groupId,
          text: text || '',
          type: hasAttachment ? 'image' : 'text',
          attachmentPath: attachmentPath ?? null,
          attachmentMime: body.attachmentMime ?? null,
          attachmentBytes: body.attachmentBytes ?? null,
          attachmentWidth: body.attachmentWidth ?? null,
          attachmentHeight: body.attachmentHeight ?? null,
        })
        .select('id, "fromId", "toId", "groupId", type, text, time, "readAt", "attachmentPath", "attachmentMime", "attachmentBytes", "attachmentWidth", "attachmentHeight"')
        .single();

      if (insertErr || !message) {
        console.error('group message insert error:', insertErr);
        return err('send_failed', 500);
      }

      const [serialized] = await withSignedAttachmentUrls(supabase, [message]);
      return ok({ message: serialized ?? message });
    }

    // Verify recipient exists, approved, same school
    const { data: recipient } = await supabase
      .from('users')
      .select('id, school, status')
      .eq('id', toId)
      .maybeSingle();

    if (!recipient)                                return err('recipient_not_found', 404);
    if (!isSameSchool(recipient.school, caller.school)) return err('cross_school_forbidden', 403);
    if (recipient.status !== 'approved')           return err('recipient_not_approved');

    const { data: message, error: insertErr } = await supabase
      .from('messages')
      .insert({
        fromId: myId,
        toId:   toId!.trim(),
        text:   text || '',
        type: hasAttachment ? 'image' : 'text',
        attachmentPath: attachmentPath ?? null,
        attachmentMime: body.attachmentMime ?? null,
        attachmentBytes: body.attachmentBytes ?? null,
        attachmentWidth: body.attachmentWidth ?? null,
        attachmentHeight: body.attachmentHeight ?? null,
      })
      .select('id, "fromId", "toId", "groupId", type, text, time, "readAt", "attachmentPath", "attachmentMime", "attachmentBytes", "attachmentWidth", "attachmentHeight"')
      .single();

    if (insertErr || !message) {
      console.error('message insert error:', insertErr);
      return err('send_failed', 500);
    }

    const [serialized] = await withSignedAttachmentUrls(supabase, [message]);
    return ok({ message: serialized ?? message });
  }

  return err('method_not_allowed', 405);
});

async function withSignedAttachmentUrls(
  supabase: ReturnType<typeof getServiceClient>,
  messages: Array<Record<string, unknown>>,
) {
  const paths = messages
    .map((message) => String(message.attachmentPath ?? ''))
    .filter(Boolean);

  if (!paths.length) return messages;

  const uniquePaths = [...new Set(paths)];
  const { data, error } = await supabase.storage
    .from('chat-media')
    .createSignedUrls(uniquePaths, 60 * 60);

  if (error) {
    console.error('signed urls error:', error);
    return messages;
  }

  const urlMap = Object.fromEntries((data ?? []).map((item) => [item.path, item.signedUrl]));

  return messages.map((message) => ({
    ...message,
    attachmentUrl: message.attachmentPath ? urlMap[String(message.attachmentPath)] ?? null : null,
  }));
}
