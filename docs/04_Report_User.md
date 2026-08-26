> **Note:** Report User Flow, Block User Flow, and the Supabase Reports MVP were requested together in a single prompt and produced as one combined response. This file contains that complete original response, unedited.

---

# MVP Implementation Proposal: Report User, Block User, Supabase Reports Backend

*Prepared for lead developer review — no files modified, no SQL executed, no migrations created.*

All findings below were re-verified directly against the **live** Supabase project (`vzjlhiqvfgrrlfdgyebx`) via the Supabase MCP (`list_tables`, `get_advisors`, `list_migrations`, and direct read-only `execute_sql` queries against `pg_policies` / `information_schema.table_privileges`), not from documentation or memory. The Figma MCP was checked but the connected file contains no Report/Block screen designs — this is noted as a gap in §8.

---

## 1. Current Architecture Analysis

Report and Block fit as **two new, narrowly-scoped moderation primitives** layered on top of the existing user/messaging system — they do not require touching `credo.js`'s core sync engine, the JWT scheme, or the school-isolation logic.

How they integrate:

- **Auth/identity**: Both flows reuse the existing custom JWT (`requireAuthWithRevocation`). The reporter/blocker identity is always `payload.sub` — never trusted from the request body — exactly like `approve`, `reject`, and `rate`.
- **Actor gating**: Both require `caller.status === 'approved'` (same gate as `messages`/`rate`). Reports do **not** require same-school with the target (a user could reasonably need to report someone before/without exchanging messages), but Block is naturally same-school-scoped since a user can only interact with same-school users at all.
- **Data model fit**: `reports` and `user_blocks` are new tables, not extensions of `users`/`messages`, so they don't touch the two most sensitive, trigger-guarded columns (`cred`, `status`) at all — lowest possible blast radius.
- **Enforcement point**: The only *behavioral* change to an existing endpoint is `messages` (`supabase/functions/messages/index.ts`), which must refuse to fetch/send between two users who have a block relationship in either direction. This is the single integration seam into existing logic — everything else is additive.
- **Client integration point**: The codebase already has an **unused extension point for exactly this purpose** — `openUserProfile()` in `app.js` (`app.js:1088`) renders `#user-profile-actions` (`index.html:481`), which today only shows "Написать" (message) for another user's profile. This is the natural, already-navigable home for "Report" and "Block" buttons — no new screen or route is needed.

---

## 2. Existing Structures

| Category | Existing asset | Reuse plan |
|---|---|---|
| Tables | `users` (id, school, status, role, cred) | FK target for `reports`/`user_blocks`; no schema change to `users` itself |
| Tables | `messages` (fromId, toId, groupId) | Read by `messages` function; optionally referenced by `reports.targetMessageId` |
| Tables | `device_blocks` | **Not reused** — this is a *device-fingerprint ban after rejection*, an unrelated concept to user-to-user blocking. Confirmed via `credo.js` (`credo_blocked`/`isDeviceBlocked()`/`blockDevice()`) and `reject_and_log()` — it has nothing to do with two approved users blocking each other. |
| Services/utils | `_shared/response.ts` (`ok`/`err`/`corsPrelight`) | Reused verbatim by both new functions |
| Services/utils | `_shared/db.ts` (`getServiceClient`) | Reused verbatim |
| Services/utils | `_shared/jwt.ts` (`requireAuthWithRevocation`) | Reused verbatim |
| Services/utils | `_shared/ratelimit.ts` (`rateLimitDb`) | Reused for report-spam prevention (new `'reports'` bucket) |
| Services/utils | `_shared/school.ts` (`isSameSchool`) | Not needed for reports (cross-school reporting should be allowed); reused implicitly for block since block targets always come from same-school lists |
| Edge Function pattern | `groups/index.ts` — single function, `GET` for list + `POST { action }` for verbs | **Primary pattern reused** for both `reports/index.ts` and `blocks/index.ts` (see §3) |
| Edge Function pattern | `rate/index.ts` — app-level fast check + DB constraint as authoritative guard (24h cooldown) | Reused for duplicate-report prevention (see §4) |
| Repositories | None (no repository layer exists — Edge Functions query Supabase directly) | N/A — matches project convention, no new abstraction introduced |
| Models | `users` row shape (`id, nickname, fullName, school, status, role, avatarUrl`) | Reused as-is for reporter/target display in the admin review queue |
| UI | `#user-profile-actions` div + `openUserProfile()` template-string pattern (`app.js:1109-1129`) | **Primary reuse target** for Report/Block buttons |
| UI | `.btn-outline`, `.btn-danger`, `.user-profile-actions` (flex row), `.toast`/`showToast()` (`notifications.js:106`) | Reused for buttons and success/error feedback |
| Navigation | `showScreen('userProfile')` / `openUserProfile(userId, returnState)` | Reused unchanged — no new screen or route |
| Client API pattern | `API.leaveGroup()` (`api.js:651`) — returns `{ ok: false, error: 'not_supported_local' }` in local-only mode | **Precedent reused**: Report/Block are backend-only features, same as `leaveGroup`. This means they do **not** need the older "optimistic local write + monkey-patch" pattern used by `approveUser`/`rejectUser`/`rateUser` — that pattern exists for features with a pre-existing local-only demo equivalent, which Report/Block don't have. |
| Client cache pattern | `credo_groups` — local cache hydrated from server response via `syncNow()`/`API.createGroup()` | Reused for a new `credo_user_blocks` local cache (needed for instant UI filtering of blocked chats before a network round-trip) |

---

## 3. Proposed MVP

### Report flow
1. User taps **"Пожаловаться"** on another user's profile (`#user-profile-actions`).
2. A small inline reason picker appears in-place (5 fixed reasons: spam, harassment, inappropriate_content, fake_profile, other + optional free-text details, max 1000 chars) — built the same way `openUserProfile` already builds `actions.innerHTML`, so no new screen/modal component is introduced.
3. Client calls `API.reportUser(targetId, reason, details)` → `POST /reports { action: 'create', targetId, reason, details }`.
4. Server validates caller is approved, target exists, not self-report, reason is one of the fixed enum values, IP rate limit (5/hour), and no other **pending** report already exists from this reporter against this target (see §4).
5. Row inserted into `reports` with `status = 'pending'`. Client shows a toast ("Жалоба отправлена") via the existing `showToast()`.
6. **No client-visible list of "my reports"** in this MVP — reports are write-only from the reporting user's perspective, consistent with keeping this MVP minimal.

### Block flow
1. User taps **"Заблокировать"** on another user's profile.
2. Confirmation via the existing `confirm()` pattern (already used elsewhere, e.g. `resetAll()` at `app.js:1830`) — no new confirmation-dialog component needed.
3. Client calls `API.blockUser(targetId)` → `POST /blocks { action: 'block', targetId }`.
4. Server upserts a row into `user_blocks` (blockerId = caller, blockedId = target).
5. Client refreshes its local `credo_user_blocks` cache from `GET /blocks` and re-renders the chat list (blocked partner's conversation is hidden) and the profile screen (button flips to "Разблокировать").
6. Blocking is **one-directional by design** (only the blocker's ability to message is a two-way effect — see Backend flow below) — the blocked user is *not* notified and does not see themselves as "blocked" anywhere, matching how most consumer apps avoid signaling block state to the blocked party.

### Backend flow
- **New tables**: `reports`, `user_blocks` (see §4).
- **New Edge Functions**: `reports/index.ts`, `blocks/index.ts` — both follow the `groups/index.ts` shape: JWT auth → load caller → `GET` for listing → `POST { action }` for verbs.
- **Modified Edge Function**: `messages/index.ts` — both the `GET` (fetch conversation) and `POST` (send) branches gain a block check via a new `_shared/blocks.ts` helper (`isBlockedEitherWay`). If either party has blocked the other, `GET` returns `err('blocked', 403)` and `POST` returns `err('blocked', 403)`.
- Block enforcement is scoped to **direct messages only** for this MVP. Group messaging (`chat_groups`/`group_members`) is explicitly **out of scope** — see §8, question 3.

### Client flow
- `credo.js`: new **local-cache-only** helpers (`getBlockedUserIds`, `setBlockedUserIds`, `isUserBlocked`) — no local-only report/block logic, matching the `leaveGroup` precedent of being backend-only.
- `api.js`: new async wrappers `reportUser()`, `blockUser()`, `unblockUser()`, `refreshBlockedUsers()` — all return `{ ok: false, error: 'not_supported_local' }` in local-only mode (`FUNCTIONS_BASE` unset), exactly like `leaveGroup()`.
- `app.js`: extend `openUserProfile()`'s action-rendering branch; filter `renderChatList()`; gate `openChat()`/send handler.

---

## 4. Database Changes

New tables are required — no equivalent structure exists (`device_blocks` is unrelated, confirmed in §2). Below is the proposed migration content for review; **it has not been applied**.

```sql
-- Migration: 026_reports_and_blocks.sql
-- Adds moderation primitives: user-submitted reports and 1:1 user blocking.
-- Security posture mirrors otp_codes / sessions / device_blocks / rate_limit_log:
-- RLS enabled, zero policies, zero anon/authenticated grants — service_role
-- (Edge Functions) is the only access path. This intentionally does NOT
-- follow the chat_groups/group_members/group_invites pattern, which the
-- live project audit found has RLS disabled and full anon/authenticated
-- grants (see Security Review, §6).

CREATE TABLE public.reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reporterId"      UUID NOT NULL REFERENCES public.users(id),
  "targetId"        UUID NOT NULL REFERENCES public.users(id),
  "targetMessageId" UUID REFERENCES public.messages(id),
  reason            TEXT NOT NULL CHECK (reason = ANY (ARRAY[
                      'spam', 'harassment', 'inappropriate_content',
                      'fake_profile', 'other'
                    ])),
  details           TEXT CHECK (details IS NULL OR char_length(details) <= 1000),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status = ANY (ARRAY['pending', 'reviewed', 'dismissed'])),
  "reviewedBy"      UUID REFERENCES public.users(id),
  "reviewedAt"      TIMESTAMPTZ,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reports_no_self_report CHECK ("reporterId" <> "targetId")
);

COMMENT ON TABLE public.reports IS
  'User-submitted moderation reports. Fully private — service_role only.';

CREATE INDEX reports_target_idx ON public.reports ("targetId");
CREATE INDEX reports_status_idx ON public.reports (status);

-- Abuse prevention: at most one *open* report per reporter→target pair.
-- App-level check in the Edge Function is the fast path; this partial unique
-- index is the authoritative DB-level guard against a race between two
-- concurrent requests — same "fast check + DB constraint" pattern used by
-- rate/index.ts + enforce_rate_cooldown for the 24h rating cooldown.
CREATE UNIQUE INDEX reports_one_pending_per_pair
  ON public.reports ("reporterId", "targetId")
  WHERE status = 'pending';

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reports FROM anon, authenticated;

CREATE TABLE public.user_blocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "blockerId" UUID NOT NULL REFERENCES public.users(id),
  "blockedId" UUID NOT NULL REFERENCES public.users(id),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_no_self_block CHECK ("blockerId" <> "blockedId"),
  CONSTRAINT user_blocks_unique UNIQUE ("blockerId", "blockedId")
);

COMMENT ON TABLE public.user_blocks IS
  '1:1 user blocking. Fully private — service_role only.';

CREATE INDEX user_blocks_blocked_idx ON public.user_blocks ("blockedId");

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_blocks FROM anon, authenticated;
```

**Why each change is required:**
- `reports` / `user_blocks` as **new tables**: no existing table can represent either concept without overloading unrelated semantics (`device_blocks` is device-fingerprint-keyed, not user-to-user).
- `RLS enabled + REVOKE ALL, no policies`: this is the *strictest and most correct* option among the three patterns already present in the live schema (fully-open, RLS-with-auth.uid()-policies, fully-closed). Fully-closed is correct here because **there is no legitimate reason for `anon`/`authenticated` to ever read or write these tables directly** — all access must be mediated by Edge Function business logic (rate limits, self-report/self-block checks, admin-only resolve).
- Partial unique index (`reports_one_pending_per_pair`): required to make duplicate-report prevention atomic under concurrency, not just a best-effort app-level check.
- No migration changes to `messages`, `users`, or any existing table — block/report enforcement is done in Edge Function code by querying the new tables, not by adding columns to `users`.

**⚠ Pre-flight issue found during this audit (not caused by this proposal):** `list_migrations` shows the live tracking table stops at `021_avatars_storage_rls`, but the live schema already includes migrations `022`–`025` (role column, groups/media, school canonicalization) — these were applied without being recorded in `supabase_migrations.schema_migrations`, confirming the drift flagged in the earlier project analysis. **The lead developer should reconcile migration history (e.g. via `supabase migration repair` or manually inserting the missing rows) before running `026_reports_and_blocks.sql` through the CLI**, or apply it the same way 022–025 were applied, to avoid the tracker rejecting/re-running already-applied migrations.

---

## 5. Required Project Changes

**Existing files that would change:**

| File | Change |
|---|---|
| `supabase/functions/messages/index.ts` | Add block check in both `GET` and `POST` branches via new `isBlockedEitherWay()` helper |
| `credo.js` | Add `getBlockedUserIds`/`setBlockedUserIds`/`isUserBlocked` local-cache helpers; add `credo_user_blocks` to `resetAll()` and the header doc comment; export new functions |
| `api.js` | Add `reportUser`, `blockUser`, `unblockUser`, `refreshBlockedUsers`; call `refreshBlockedUsers()` from `syncNow()`/login flow; export on the public `API` object |
| `app.js` | Extend `openUserProfile()`'s action-rendering branch (Report/Block buttons); filter `renderChatList()` to hide/gray blocked partners; gate `openChat()` and the send handler when a block exists |
| `index.html` | No structural change required — `#user-profile-actions` already exists as an empty, JS-populated container |
| `style.css` | No new classes required — `.btn-outline`, `.btn-danger`, `.user-profile-actions` already cover the needed styling |

**New files:**

| File | Purpose |
|---|---|
| `supabase/migrations/20260805000000_026_reports_and_blocks.sql` | Schema for §4 |
| `supabase/functions/reports/index.ts` | Create + admin-review Edge Function |
| `supabase/functions/blocks/index.ts` | Block/unblock + list Edge Function |
| `supabase/functions/_shared/blocks.ts` | `isBlockedEitherWay()` helper, reused by `messages` |

**API changes:** two new endpoints (`/reports`, `/blocks`); one existing endpoint (`/messages`) gains a new `403 blocked` error case on both verbs.

**Navigation changes:** none — everything routes through the existing `openUserProfile`/`showScreen('userProfile')`/`openChat` flow.

**Model changes:** none to `users`/`messages` row shapes returned by existing endpoints; two new row shapes (`reports`, `user_blocks`) introduced, internal to the new endpoints only.

### New Edge Function: `supabase/functions/_shared/blocks.ts`

```typescript
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** True if either user has blocked the other, in either direction. */
export async function isBlockedEitherWay(
  supabase: SupabaseClient,
  userA: string,
  userB: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_blocks')
    .select('id')
    .or(
      `and("blockerId".eq.${userA},"blockedId".eq.${userB}),` +
      `and("blockerId".eq.${userB},"blockedId".eq.${userA})`,
    )
    .limit(1);

  if (error) throw error;
  return Boolean(data?.length);
}
```

### New Edge Function: `supabase/functions/blocks/index.ts`

```typescript
/**
 * Edge Function: /functions/v1/blocks
 *
 * GET  — list the caller's own blocked user ids.
 * POST { action: 'block' | 'unblock', targetId } — toggle a block.
 *
 * Mirrors the action-routed shape of groups/index.ts.
 */

import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';

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

  const { data: caller } = await supabase
    .from('users')
    .select('id, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller)                      return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  if (req.method === 'GET') {
    const { data: rows, error: fetchErr } = await supabase
      .from('user_blocks')
      .select('"blockedId"')
      .eq('blockerId', caller.id);

    if (fetchErr) {
      console.error('blocks fetch error:', fetchErr);
      return err('fetch_failed', 500);
    }

    return ok({ blockedIds: (rows ?? []).map((row: { blockedId: string }) => row.blockedId) });
  }

  if (req.method !== 'POST') return err('method_not_allowed', 405);

  let body: { action?: string; targetId?: string };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const action   = String(body.action ?? '').trim();
  const targetId = String(body.targetId ?? '').trim();

  if (!targetId)              return err('targetId_required');
  if (targetId === caller.id) return err('cannot_block_self');

  const { data: target } = await supabase
    .from('users')
    .select('id')
    .eq('id', targetId)
    .maybeSingle();

  if (!target) return err('user_not_found', 404);

  if (action === 'block') {
    const { error: insertErr } = await supabase
      .from('user_blocks')
      .upsert({ blockerId: caller.id, blockedId: targetId }, { onConflict: 'blockerId,blockedId' });

    if (insertErr) {
      console.error('block insert error:', insertErr);
      return err('block_failed', 500);
    }
    return ok({ blockedId: targetId });
  }

  if (action === 'unblock') {
    const { error: deleteErr } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blockerId', caller.id)
      .eq('blockedId', targetId);

    if (deleteErr) {
      console.error('unblock error:', deleteErr);
      return err('unblock_failed', 500);
    }
    return ok({ unblockedId: targetId });
  }

  return err('unsupported_action');
});
```

### New Edge Function: `supabase/functions/reports/index.ts`

```typescript
/**
 * Edge Function: /functions/v1/reports
 *
 * GET  (admin only) ?status=pending|reviewed|dismissed — review queue.
 * POST { action: 'create', targetId, reason, details? }  — any approved user.
 * POST { action: 'resolve', reportId, decision }         — admin only.
 */

import { ok, err, corsPrelight }     from '../_shared/response.ts';
import { getServiceClient }          from '../_shared/db.ts';
import { requireAuthWithRevocation } from '../_shared/jwt.ts';
import { rateLimitDb }               from '../_shared/ratelimit.ts';

const REASONS = ['spam', 'harassment', 'inappropriate_content', 'fake_profile', 'other'];

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

  const { data: caller } = await supabase
    .from('users')
    .select('id, role, status')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!caller)                      return err('caller_not_found', 404);
  if (caller.status !== 'approved') return err('forbidden', 403);

  // ── GET: admin review queue ────────────────────────────────────────────
  if (req.method === 'GET') {
    if (caller.role !== 'admin') return err('admin_only', 403);

    const url    = new URL(req.url);
    const status = url.searchParams.get('status') ?? 'pending';

    const { data: reports, error: fetchErr } = await supabase
      .from('reports')
      .select('id, "reporterId", "targetId", "targetMessageId", reason, details, status, "createdAt"')
      .eq('status', status)
      .order('createdAt', { ascending: true });

    if (fetchErr) {
      console.error('reports fetch error:', fetchErr);
      return err('fetch_failed', 500);
    }

    const userIds = [...new Set(
      (reports ?? []).flatMap((r: { reporterId: string; targetId: string }) => [r.reporterId, r.targetId]),
    )];

    const { data: users, error: usersErr } = userIds.length
      ? await supabase.from('users').select('id, nickname, "fullName", school').in('id', userIds)
      : { data: [], error: null };

    if (usersErr) {
      console.error('report users fetch error:', usersErr);
      return err('fetch_failed', 500);
    }

    const userMap = Object.fromEntries((users ?? []).map((u: { id: string }) => [u.id, u]));

    return ok({
      reports: (reports ?? []).map((r: Record<string, unknown>) => ({
        ...r,
        reporter: userMap[r.reporterId as string] ?? null,
        target:   userMap[r.targetId as string] ?? null,
      })),
    });
  }

  if (req.method !== 'POST') return err('method_not_allowed', 405);

  let body: {
    action?: string; targetId?: string; reason?: string;
    details?: string; reportId?: string; decision?: string;
  };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json');
  }

  const action = String(body.action ?? 'create').trim();

  // ── Admin resolve ───────────────────────────────────────────────────────
  if (action === 'resolve') {
    if (caller.role !== 'admin') return err('admin_only', 403);

    const reportId = String(body.reportId ?? '').trim();
    const decision = String(body.decision ?? '').trim();
    if (!reportId)                                 return err('reportId_required');
    if (!['reviewed', 'dismissed'].includes(decision)) return err('invalid_decision');

    const { error: updateErr } = await supabase
      .from('reports')
      .update({ status: decision, reviewedBy: caller.id, reviewedAt: new Date().toISOString() })
      .eq('id', reportId)
      .eq('status', 'pending');

    if (updateErr) {
      console.error('report resolve error:', updateErr);
      return err('resolve_failed', 500);
    }
    return ok({ reportId, status: decision });
  }

  // ── Create report ───────────────────────────────────────────────────────
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  const allowed = await rateLimitDb(supabase, ip, 'reports', 5, 60 * 60_000);
  if (!allowed) return err('rate_limit_exceeded', 429);

  const targetId = String(body.targetId ?? '').trim();
  const reason   = String(body.reason ?? '').trim();
  const details  = body.details ? String(body.details).trim().slice(0, 1000) : null;

  if (!targetId)                 return err('targetId_required');
  if (targetId === caller.id)    return err('cannot_report_self');
  if (!REASONS.includes(reason)) return err('invalid_reason');

  const { data: target } = await supabase.from('users').select('id').eq('id', targetId).maybeSingle();
  if (!target) return err('user_not_found', 404);

  const { error: insertErr } = await supabase.from('reports').insert({
    reporterId: caller.id,
    targetId,
    reason,
    details,
  });

  if (insertErr) {
    if (insertErr.code === '23505') return err('report_already_pending', 409);
    console.error('report insert error:', insertErr);
    return err('report_failed', 500);
  }

  return ok({ targetId, status: 'pending' });
});
```

### Modification to `supabase/functions/messages/index.ts`

Add a block check right after the caller/target lookups in both branches (illustrative — exact insertion point shown, not a full file rewrite):

```typescript
// Added import
import { isBlockedEitherWay } from '../_shared/blocks.ts';

// Inside the `GET` branch, after loading `partner` and before the messages query:
if (await isBlockedEitherWay(supabase, myId, partnerId)) {
  return err('blocked', 403);
}

// Inside the `POST` branch, after loading `recipient` and before the insert:
if (toId && await isBlockedEitherWay(supabase, myId, toId)) {
  return err('blocked', 403);
}
```

### Client changes — `credo.js`

```javascript
// --------------- Блокировки пользователей (локальный кэш) ---------------
// credo_user_blocks — JSON-объект { [userId]: [blockedUserId, ...] }
// Это кэш серверных данных (см. API.refreshBlockedUsers), не источник истины —
// в отличие от credo_settings, эти данные синхронизируются с backend.

function getBlockedUserIds(userId) {
  const all = loadJSON('credo_user_blocks', {});
  return all[userId] || [];
}

function setBlockedUserIds(userId, blockedIds) {
  if (!userId) return;
  const all = loadJSON('credo_user_blocks', {});
  all[userId] = blockedIds;
  saveJSON('credo_user_blocks', all);
}

function isUserBlocked(userId, otherUserId) {
  return getBlockedUserIds(userId).includes(otherUserId);
}
```

Plus: add `credo_user_blocks` removal to `resetAll()`, the header doc comment, and the public API export — same three touch points already used for the Settings screen's `credo_settings` key.

### Client changes — `api.js`

```javascript
async function reportUser(targetId, reason, details) {
  if (!FUNCTIONS_BASE) return { ok: false, error: 'not_supported_local' };
  return _call('/reports', { method: 'POST', body: { action: 'create', targetId, reason, details } });
}

async function blockUser(targetId) {
  if (!FUNCTIONS_BASE) return { ok: false, error: 'not_supported_local' };
  const result = await _call('/blocks', { method: 'POST', body: { action: 'block', targetId } });
  if (result.ok) await refreshBlockedUsers();
  return result;
}

async function unblockUser(targetId) {
  if (!FUNCTIONS_BASE) return { ok: false, error: 'not_supported_local' };
  const result = await _call('/blocks', { method: 'POST', body: { action: 'unblock', targetId } });
  if (result.ok) await refreshBlockedUsers();
  return result;
}

async function refreshBlockedUsers() {
  if (!FUNCTIONS_BASE) return;
  const userId = Credo.getCurrentUserId();
  if (!userId) return;
  const result = await _call('/blocks');
  if (result?.ok) Credo.setBlockedUserIds(userId, result.blockedIds || []);
}
```

`refreshBlockedUsers()` should also be called once from wherever `syncNow()`/login-success currently refreshes other cached lists, so the cache is warm before the chat list first renders.

### Client changes — `app.js` (illustrative, key touch points)

In `openUserProfile()`'s `else` branch (`app.js:1122-1128`), extend the actions markup:

```javascript
} else {
  const blocked = Credo.isUserBlocked(viewer.id, user.id);
  actions.innerHTML = `
    <button class="btn btn-primary btn-small" type="button" data-open-profile-chat="${user.id}">Написать</button>
    <button class="btn btn-outline btn-small" type="button" data-report-user="${user.id}">Пожаловаться</button>
    <button class="btn ${blocked ? 'btn-outline' : 'btn-danger'} btn-small" type="button" data-toggle-block="${user.id}">
      ${blocked ? 'Разблокировать' : 'Заблокировать'}
    </button>
  `;
  // ... existing chat button wiring, plus:
  actions.querySelector('[data-report-user]')?.addEventListener('click', () => openReportPicker(user.id, actions));
  actions.querySelector('[data-toggle-block]')?.addEventListener('click', () => handleToggleBlock(user.id, blocked));
}
```

`renderChatList()` (`app.js:518`) needs a filter so a blocked partner's conversation doesn't appear in the list (or appears visually disabled); `openChat()` (`app.js:1159`) and the send-message handler need an early-return with a toast ("Переписка недоступна") when `Credo.isUserBlocked` returns true for the current pair, matching the error the backend will now also return.

---

## 6. Security Review

**RLS:** New tables follow the strictest pattern already present in the live schema (RLS enabled, zero policies, zero grants — same as `otp_codes`/`sessions`/`device_blocks`/`rate_limit_log`), not the pattern used for `users`/`messages`/`rate_log` (RLS enabled with `auth.uid()`-based SELECT policies). This is a deliberate choice: those `auth.uid()` policies are **effectively decorative** for this app's real traffic — confirmed live via `pg_policies` — because the app uses a custom JWT, not Supabase Auth, so `auth.uid()` is always `NULL` for the app's actual PostgREST calls. Real protection for those tables comes from the *combination* of that inert RLS **and** the explicit `REVOKE INSERT, UPDATE, DELETE` in migration 019. For `reports`/`user_blocks`, since there is no legitimate direct-client use case at all (unlike `users_safe`, which needs to be readable for basic profile display), full closure is simpler and strictly safer than replicating the inert-RLS pattern.

**A pre-existing critical vulnerability, confirmed still live during this audit, that any new table must not repeat:** `chat_groups`, `group_members`, and `group_invites` have **RLS disabled** and **full INSERT/SELECT/UPDATE/DELETE grants to `anon` and `authenticated`** — verified independently via both `get_advisors` (still reporting this as a `critical`-level `rls_disabled` finding) and a direct `information_schema.table_privileges` query. This means anyone with only the public anon key — no valid JWT, no approved account — can currently read or overwrite any group/membership/invite row directly via PostgREST, completely bypassing the Edge Functions' school/approval/role checks. **This proposal deliberately does the opposite for `reports`/`user_blocks`** (full closure), but the underlying gap in `chat_groups`/`group_members`/`group_invites` remains unresolved and should be treated as a separate, urgent hardening task — not addressed here since it's out of scope for this proposal and the instructions prohibit executing changes.

**A second, more subtle finding from this same audit, also pre-existing and unrelated to this proposal:** the `users_safe` view (migration 019) shows live `INSERT`/`UPDATE`/`DELETE` grants to `anon`/`authenticated` in `information_schema.table_privileges`, even though the migration source only explicitly grants `SELECT`. This is very likely a side effect of Supabase's project-level default privileges applying to newly created objects that aren't explicitly `REVOKE`d (every other hardened object in migration 019 *is* explicitly revoked; `users_safe` was not). In practice this is probably neutralized because `users` has RLS enabled with **only `SELECT` policies** — Postgres denies `UPDATE`/`INSERT`/`DELETE` by default when RLS is on and no policy exists for that command — but this relies on an implicit RLS default rather than an explicit `REVOKE`, unlike the project's own stated defense-in-depth principle. Worth an explicit `REVOKE INSERT, UPDATE, DELETE ON public.users_safe FROM anon, authenticated;` as a follow-up, independent of this proposal.

**Abuse prevention:**
- *Duplicate reports*: partial unique index (`reports_one_pending_per_pair`) + app-level pre-check, mirroring the existing `rate`/`enforce_rate_cooldown` two-layer pattern.
- *Report spam*: IP rate limit via `rateLimitDb` (5/hour), same helper/table as `login`/`register`/`messages`/`rate`.
- *Self-report / self-block*: enforced both at the CHECK-constraint level (DB) and Edge Function level (defense in depth, matching `cannot_approve_self`/`cannot_reject_self`/`self` in existing functions).
- *Block bypass via group chat*: **not covered** in this MVP (see §3, §8 Q3) — a blocked pair can still see each other in a shared school-public group.

**Blocked users / privacy implications:** Block state is not exposed to the blocked user in any response shape (`GET /blocks` only returns the *caller's* blocked list). Reports are never visible to the reported user. Both match common product expectations for these features.

**New function EXECUTE grants:** Every new SQL-level object here is a table, not a `SECURITY DEFINER` function, so the WARN-level advisory finding on functions like `apply_cred_delta`/`approve_and_log` being `anon`/`authenticated`-EXECUTE-able (confirmed still live via `get_advisors`) does not apply to this proposal directly. Worth flagging though, since it's directly relevant if the lead developer later wants an atomic RPC for report/block writes: migration 019's `REVOKE ALL ON FUNCTION ... FROM PUBLIC` does **not** actually strip `anon`/`authenticated` EXECUTE — the live advisor still flags all of `approve_and_log`, `reject_and_log`, `apply_cred_delta`, etc. as callable by both roles. This is almost certainly because Supabase projects auto-grant `EXECUTE` to `anon`/`authenticated` via default privileges at function-creation time, and `REVOKE ... FROM PUBLIC` doesn't remove a separate, already-materialized grant to a named role. **If any future report/block logic is moved into a SQL function, it must explicitly `REVOKE EXECUTE ... FROM anon, authenticated;` (naming the roles), not rely on `REVOKE ALL FROM PUBLIC` alone** — this MVP avoids the issue entirely by not introducing new SQL functions.

---

## 7. Risks

**Architectural risks**
- Low — both features are purely additive; the only touch to existing logic is two new early-return checks inside `messages/index.ts`.
- The "backend-only, no local shadow" pattern (mirroring `leaveGroup`) means these features silently do nothing useful in local-demo mode. Acceptable since moderation has no meaningful local-only equivalent, but worth confirming with the lead developer (§8 Q1).

**Security risks**
- If the lead developer chooses to reuse the "action-routed single function" pattern loosely and later adds more actions to `reports`/`blocks` without re-auditing grants, there's a repeatable risk of recreating the `chat_groups`-style gap — every new table added going forward should have its grants explicitly checked against `information_schema.table_privileges`, not assumed from migration source alone (as this audit's `users_safe` finding shows, the two can diverge).
- Reports contain no PII beyond user IDs and free-text `details` — but `details` is user-authored free text with no server-side sanitization beyond length-capping. Since it's only ever rendered inside an admin-only surface (not yet built in this MVP — see §8 Q5), XSS risk is currently theoretical but should be escaped with the same `escapeHtml` convention used elsewhere in `app.js` once an admin UI is built.

**Scalability risks**
- Negligible at current scale (18 users, low message volume). `user_blocks` lookup on every message GET/POST adds one extra indexed query per call — trivial cost.

**App Store review risks**
- Not applicable — this is a web app with no App Store distribution component (confirmed in the original project analysis).

---

## 8. Questions For The Lead Developer

1. **Local-only mode**: Should Report/Block be fully backend-only (returning `not_supported_local`, matching `leaveGroup`), or is a local-demo stub desired for consistency with the rest of the app's dual-mode design?
2. **Blocked-user visibility scope**: Should a blocked user disappear from the general user roster/leaderboard (`users`/`renderUsersTab`) entirely, or only lose the ability to message (this proposal's default, chosen to minimize blast radius)? Full delisting would require changes to `users/index.ts` and cred-rating eligibility (`rateTargets` filter) that are out of scope here.
3. **Group chat block enforcement**: This MVP scopes block enforcement to direct messages only. Should a blocked pair also be prevented from seeing each other's messages inside a shared `chat_groups`/`school_public` group? That would be a materially larger change (per-message filtering inside `messages/index.ts`'s `groupId` branch) and is deliberately deferred.
4. **Report reason taxonomy**: Is the proposed fixed 5-value enum (`spam`, `harassment`, `inappropriate_content`, `fake_profile`, `other`) the right set for a school-community messenger, or should it be adjusted before locking it into a `CHECK` constraint (which requires a migration to change later)?
5. **Admin review UI**: This proposal only adds the `GET /reports` backend endpoint for admins — no admin-facing screen to actually view/resolve the queue was requested or built. Should that be scoped as a follow-up task (e.g., a new tab inside the existing admin surface, alongside `admin-stats`)?
6. **Report consequences**: This MVP only records reports — it does not auto-suspend, auto-hide, or notify anyone. Is that acceptable for a first release, with any automated action (e.g., auto-hide after N reports) deferred?
7. **Figma**: No Report/Block screen designs were found in the connected Figma file. Should this proposal's UI (inline buttons + inline reason picker, no new screen) be treated as the design, or is a design pass expected before implementation?
8. **Pre-existing security gaps found during this audit** (`chat_groups`/`group_members`/`group_invites` RLS-disabled + open grants; `users_safe` view's unintended write grants; the `REVOKE ALL FROM PUBLIC` vs. explicit role-named `REVOKE EXECUTE` gap on existing `SECURITY DEFINER` functions) — should these be filed as separate hardening tickets independent of this feature work?

---

## 9. Confidence

| Conclusion | Basis |
|---|---|
| Live table list, columns, RLS flags, FK graph | **Supabase MCP** (`list_tables`, verbose) — fact |
| `chat_groups`/`group_members`/`group_invites` RLS disabled + open anon/authenticated grants | **Supabase MCP** (`get_advisors` + direct `execute_sql` against `information_schema.table_privileges`) — fact, independently cross-checked two ways |
| Live RLS policies (`auth.uid()`-based, effectively inert for custom-JWT traffic) | **Supabase MCP** (`execute_sql` against `pg_policies`) — fact |
| `users_safe` view has unintended DML grants likely from default privileges | **Supabase MCP** (`execute_sql`) for the grant fact; the *cause* (default privileges not explicitly revoked) is **inference** based on comparing migration 019's source to the live grant state |
| Migration history drift (021 tracked, 022–025 live but untracked) | **Supabase MCP** (`list_migrations`) cross-referenced with **existing source code** (`supabase/migrations/*.sql` files present locally) — fact |
| `SECURITY DEFINER` functions still `anon`/`authenticated`-EXECUTE-able despite `REVOKE ALL FROM PUBLIC` | **Supabase MCP** (`get_advisors`) for the fact; the explanation (default privileges to named roles surviving a `PUBLIC`-only revoke) is **inference**, standard Postgres/Supabase behavior but not itself re-verified against `pg_default_acl` in this session |
| `messages`/`groups`/`rate`/`admin-stats`/`me`/`users` Edge Function shapes and conventions | **Existing source code** (direct file reads) — fact |
| `openUserProfile`/`#user-profile-actions` as the correct integration point | **Existing source code** — fact (this container already exists, is already wired for "another user's profile", and is currently underused — one button only) |
| `device_blocks` is unrelated to user-to-user blocking | **Existing source code** (`credo.js`, `reject/index.ts`) — fact |
| `leaveGroup`'s `not_supported_local` as the precedent for backend-only features | **Existing source code** (`api.js:651-652`) — fact |
| No existing Report/Block documentation or partial implementation | **Project documentation** (`BACKEND.md` grep) + **existing source code** (grep across `app.js`/`credo.js`) — fact (absence confirmed, not assumed) |
| No Report/Block Figma designs available | **Figma MCP** — the connected file was checked; no matching frames were found. Stated as a gap, not a guess. |
| Reason taxonomy (5 fixed values), rate limit thresholds (5/hour reports), block scope (DMs only, not groups) | **Inference** — reasonable MVP defaults modeled on the existing `rate`/`messages` thresholds and patterns, but genuinely product decisions, flagged explicitly in §8 |
| `REVOKE ALL ... FROM PUBLIC` not covering named-role grants | **Inference** grounded in the observed advisor output, not independently verified via `pg_default_acl`/`aclexplode` in this session — flagged as inference, not fact, and recommended as a discussion point rather than asserted as certain root cause |