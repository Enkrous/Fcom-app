# Fcom — Backend Setup Guide

## Overview

Backend is implemented entirely on **Supabase**:

| Layer | Technology |
|---|---|
| Database | Supabase Postgres |
| API | Supabase Edge Functions (Deno) |
| Auth | Custom JWT (HS256) via Edge Functions |
| Data protection | Row Level Security (RLS) |
| Password hashing | PBKDF2-SHA256 (100 000 iterations, random salt, via Web Crypto API) |
| Rate limiting | Persistent — `rate_limit_log` table (works across multiple workers) |
| Scheduled cleanup | pg_cron — expires sessions and OTP codes hourly |

Frontend HTML, `app.js`, and `credo.js` are **not modified**.
Only `api.js` is updated — it acts as a bridge that monkey-patches `Credo.*` write methods and fetches from Edge Functions.

---

## Local demo mode

Set `SUPABASE_URL = ''` in `api.js` (line 25) to run entirely in localStorage — no Supabase project needed. This is the original demo behaviour.

---

## Connecting to Supabase

### Step 1 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Note: **Project URL** and **service_role key** from Settings → API

### Step 2 — Run migrations

In the Supabase dashboard, open **SQL Editor** and run these files **in order**:

```
migrations/001_create_users.sql
migrations/002_create_otp_codes.sql
migrations/003_create_sessions.sql
migrations/004_create_messages.sql
migrations/005_create_rate_log.sql
migrations/006_create_device_blocks.sql
migrations/007_rls_policies.sql
migrations/008_functions_triggers.sql
migrations/009_pg_cron_cleanup.sql
migrations/010_rate_limit_log.sql
migrations/011_users_missing_constraints.sql
migrations/012_rate_log_db_constraints.sql
migrations/013_approval_log.sql
migrations/014_messages_read_status.sql
migrations/015_otp_attempts_counter.sql
migrations/016_approve_reject_rpc.sql
migrations/017_rate_atomic_rpc.sql
migrations/018_messages_unread_rpc.sql
migrations/019_security_hardening.sql
```

Or use the Supabase CLI:

```bash
supabase db push
```

### Step 3 — Set Edge Function secrets

In the Supabase dashboard → **Settings → Edge Functions → Secrets**, add:

| Key | Value |
|---|---|
| `JWT_SECRET` | A random string, at least 32 characters |
| `CLEANUP_SECRET` | A random string used to authenticate the /cleanup endpoint |
| `SMS_API_URL` | *(optional)* Your SMS provider endpoint |
| `SMS_API_KEY` | *(optional)* Your SMS provider API key |

Or via CLI:

```bash
supabase secrets set JWT_SECRET=your_random_secret_here
supabase secrets set CLEANUP_SECRET=another_random_secret_here
```

### Step 4 — Deploy Edge Functions

```bash
supabase functions deploy register
supabase functions deploy verify-phone
supabase functions deploy set-password
supabase functions deploy login
supabase functions deploy logout
supabase functions deploy approve
supabase functions deploy reject
supabase functions deploy rate
supabase functions deploy messages
supabase functions deploy users
supabase functions deploy resend-otp
supabase functions deploy cleanup
```

Or deploy all at once:

```bash
supabase functions deploy
```

### Step 5 — Configure `api.js`

Open `api.js` and set your project URL on line 25:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
```

### Step 6 — (Production) Configure CORS

Open `supabase/functions/_shared/response.ts` and replace the wildcard origin
with your actual deployment domain:

```typescript
'Access-Control-Allow-Origin': 'https://your-app-domain.com',
```

---

## File Structure

```
.
├── index.html                  ← Frontend (unchanged)
├── style.css                   ← Styles (unchanged)
├── credo.js                    ← Local state engine (unchanged)
├── app.js                      ← UI logic (unchanged)
├── api.js                      ← Bridge: local ↔ backend ← EDITED
│
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_create_otp_codes.sql
│   ├── 003_create_sessions.sql
│   ├── 004_create_messages.sql
│   ├── 005_create_rate_log.sql
│   ├── 006_create_device_blocks.sql
│   ├── 007_rls_policies.sql
│   ├── 008_functions_triggers.sql
│   ├── 009_pg_cron_cleanup.sql         ← pg_cron: hourly session/OTP cleanup
│   ├── 010_rate_limit_log.sql          ← persistent rate limit table
│   ├── 011_users_missing_constraints.sql ← fullName unique (CI) + phone unique
│   ├── 012_rate_log_db_constraints.sql ← no-self-rate CHECK + 24h cooldown trigger
│   ├── 013_approval_log.sql            ← approval/rejection audit log table
│   ├── 014_messages_read_status.sql    ← readAt field + mark_messages_read()
│   ├── 015_otp_attempts_counter.sql   ← attempts column + brute-force protection
│   ├── 016_approve_reject_rpc.sql    ← atomic approve/reject RPCs, fixes actor logging
│   ├── 017_rate_atomic_rpc.sql       ← rate_and_apply: atomic INSERT rate_log + UPDATE cred
│   ├── 018_messages_unread_rpc.sql   ← get_unread_counts + conversation_summary RPCs
│   └── 019_security_hardening.sql   ← explicit REVOKE, column security, safe view, guard trigger
│
└── supabase/
    ├── config.toml
    └── functions/
        ├── _shared/
        │   ├── db.ts               ← Supabase service_role client
        │   ├── jwt.ts              ← Custom HS256 JWT sign/verify + revocation check
        │   ├── bcrypt.ts           ← PBKDF2-SHA256 password hashing
        │   ├── ratelimit.ts        ← Persistent DB-backed rate limiter
        │   └── response.ts         ← Uniform { ok, error } response helpers
        ├── register/               → POST /functions/v1/register
        ├── verify-phone/           → POST /functions/v1/verify-phone
        ├── set-password/           → POST /functions/v1/set-password
        ├── login/                  → POST /functions/v1/login
        ├── logout/                 → POST /functions/v1/logout           ← NEW
        ├── approve/                → POST /functions/v1/approve
        ├── reject/                 → POST /functions/v1/reject
        ├── rate/                   → POST /functions/v1/rate
        ├── messages/               → GET|POST /functions/v1/messages
        ├── users/                  → GET /functions/v1/users
        ├── resend-otp/             → POST /functions/v1/resend-otp       ← NEW
        └── cleanup/                → POST /functions/v1/cleanup          ← NEW
```

---

## API Reference

All responses follow: `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/functions/v1/register` | — | Register a new user |

### POST `/functions/v1/verify-phone` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `invalid_json` | 400 | Request body could not be parsed |
| `phone_required` | 400 | `phone` field is missing or blank |
| `code_required` | 400 | `code` field is missing or blank |
| `too_many_attempts` | 429 | IP+phone rate limit exceeded **or** OTP attempt cap (5 wrong codes) reached |
| `user_not_found` | 404 | No user exists with that phone number |
| `otp_not_found_or_expired` | 400 | No valid OTP exists for that phone (expired, used, or attempt cap reached) |
| `invalid_code` | 400 | Code does not match; response also includes `attemptsLeft: N` |
| `verification_failed` | 500 | Unexpected DB error when setting `phoneVerified = true` |

> **Dev mode shortcut**: when `SMS_API_URL` is not configured, submitting `"000000"` as the code is always accepted (useful for automated testing without a real SMS provider).

### POST `/functions/v1/verify-phone` — Success Response

```json
{ "ok": true, "userId": "uuid" }
```

Already-verified shortcut (idempotent):
```json
{ "ok": true, "already_verified": true }
```

---

### POST `/functions/v1/resend-otp` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `invalid_json` | 400 | Request body could not be parsed |
| `phone_required` | 400 | `phone` field is missing or blank |
| `too_many_attempts` | 429 | More than 3 resend requests from the same IP+phone in 10 min |
| `user_not_found` | 404 | No user exists with that phone number |
| `no_phone_on_record` | 400 | The user record has no phone number stored |
| `otp_create_failed` | 500 | Unexpected DB error during OTP INSERT |

### POST `/functions/v1/resend-otp` — Success Response

Production (SMS sent):
```json
{ "ok": true }
```

Dev mode (no SMS provider):
```json
{ "ok": true, "_devOtp": "482951" }
```

---

### POST `/functions/v1/register` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `invalid_json` | 400 | Request body could not be parsed as JSON |
| `fullName_required` | 400 | `fullName` field is missing or blank |
| `school_required` | 400 | `school` field is missing or blank |
| `grade_required` | 400 | `grade` field is missing or blank |
| `nickname_required` | 400 | `nickname` field is missing or blank |
| `rate_limit_exceeded` | 429 | More than 5 registration attempts from the same IP in 60 s |
| `device_blocked` | 403 | Device fingerprint is in the `device_blocks` table (previous rejection) |
| `nickname_taken` | 400 | A user with the same nickname already exists (case-insensitive) |
| `phone_taken` | 400 | A user with the same phone number already exists |
| `fullName_taken` | 400 | A user with the same full name already exists (case-insensitive) |
| `registration_failed` | 500 | Unexpected database error during INSERT |

### POST `/functions/v1/register` — Success Response

```json
{
  "ok": true,
  "user": {
    "id": "uuid",
    "fullName": "Иванов Иван Иванович",
    "school": "Школа №1",
    "grade": "9А",
    "nickname": "ivan",
    "phone": "+79001234567",
    "phoneVerified": false,
    "status": "pending",
    "cred": 0,
    "createdAt": "2026-04-15T10:00:00.000Z"
  },
  "token": "<jwt>",
  "_devOtp": "482951"
}
```

> `token` — 1-hour JWT for calling `/set-password`. Present only when `JWT_SECRET` is configured.  
> `_devOtp` — OTP code for phone verification. **Only returned in dev mode** (when `SMS_API_URL` is not set). Remove from production.
| POST | `/functions/v1/verify-phone` | — | Verify OTP code |
| POST | `/functions/v1/set-password` | JWT (reg token) | Set initial password |
| POST | `/functions/v1/login` | — | Login, returns JWT |
| POST | `/functions/v1/logout` | JWT (session) | Revoke session server-side |
| POST | `/functions/v1/approve` | JWT (approved) | Approve a pending user |
| POST | `/functions/v1/reject` | JWT (approved) | Reject a pending user |
| POST | `/functions/v1/rate` | JWT (approved) | Rate a user (Кредо) |
| GET | `/functions/v1/messages?partnerId=` | JWT (approved) | Fetch conversation |
| POST | `/functions/v1/messages` | JWT (approved) | Send a message |
| GET | `/functions/v1/users` | JWT (approved) | List users in school |
| POST | `/functions/v1/verify-phone` | — | Verify OTP code, set phoneVerified = true |
| POST | `/functions/v1/resend-otp` | — | Invalidate old OTPs, send a new code |
| POST | `/functions/v1/cleanup` | CLEANUP_SECRET | Purge expired rows (cron) |

### POST `/functions/v1/login` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `invalid_json` | 400 | Request body could not be parsed |
| `nickname_required` | 400 | `nickname` field is missing or blank |
| `password_required` | 400 | `password` field is missing or blank |
| `rate_limit_exceeded` | 429 | More than 10 login attempts from the same IP in 60 s |
| `invalid_credentials` | 401 | User not found, no password set, or wrong password (generic — prevents enumeration) |
| `account_rejected` | 403 | Account was rejected; login permanently blocked |
| `account_not_approved` | 403 | Account is still pending approval |
| `phone_not_verified` | 403 | Phone is on file but not yet verified via OTP |
| `server_misconfigured` | 500 | `JWT_SECRET` env var is not set |

### POST `/functions/v1/login` — Success Response

```json
{
  "ok": true,
  "token": "<jwt>",
  "user": {
    "id": "uuid",
    "fullName": "Иванов Иван Иванович",
    "school": "Школа №1",
    "grade": "9А",
    "nickname": "ivan",
    "phone": "+79001234567",
    "phoneVerified": true,
    "status": "approved",
    "cred": 12.5,
    "createdAt": "2026-04-15T10:00:00.000Z"
  }
}
```

---

## JWT — Structure & Verification

### Token Payload

```json
{
  "sub":      "uuid",        // userId — primary identity claim
  "jti":      "uuid",        // session ID — used for server-side revocation via /logout
  "iat":      1713175200,    // issued-at (Unix timestamp)
  "exp":      1713780000,    // expiry — 7 days after iat for login token, 1 h for registration token
  "nickname": "ivan",        // quick access without DB round-trip
  "status":   "approved",    // allows middleware to gate on account state
  "school":   "Школа №1"    // cross-school isolation check
}
```

Algorithm: **HS256** (HMAC-SHA256). Secret set via `JWT_SECRET` env var (min 32 chars).

### Token Lifetime

| Token type | TTL | Purpose |
|---|---|---|
| Login JWT | **7 days** | Returned by `/login` — full session access |
| Registration JWT | **1 hour** | Returned by `/register` — only valid for `/set-password` |

### Verifying a Token (protected endpoint pattern)

Every protected Edge Function calls one of these helpers from `_shared/jwt.ts`:

```typescript
// Basic verification (signature + expiry only)
const payload = await requireAuth(req, jwtSecret);

// Full verification including session revocation check (recommended)
const payload = await requireAuthWithRevocation(req, jwtSecret, supabase);
// Throws 'session_revoked' if the session was deleted via /logout
```

`requireAuthWithRevocation` looks up `payload.jti` in the `sessions` table.
If no matching row is found the request is rejected — this is how `/logout` invalidates tokens
even before they expire.

### Protected Routes

All routes below require `Authorization: Bearer <token>` header with a valid, non-revoked JWT.
The `status` claim in the token must be `'approved'` (enforced inside each function).

| Method | Path | Required claim | Notes |
|---|---|---|---|
| POST | `/functions/v1/set-password` | `sub` (any status) | Registration token accepted |
| POST | `/functions/v1/logout` | `jti` | Deletes session row |
| POST | `/functions/v1/approve` | `status = approved` | Approves a pending user in same school |
| POST | `/functions/v1/reject` | `status = approved` | Rejects a pending user in same school |
| POST | `/functions/v1/rate` | `status = approved` | Rates another user (Кредо score) |
| GET  | `/functions/v1/messages` | `status = approved` | Fetch conversation with a partner |
| POST | `/functions/v1/messages` | `status = approved` | Send a message |
| GET  | `/functions/v1/users` | `status = approved` | List approved + pending users in school |

Public routes (no token required): `/register`, `/verify-phone`, `/resend-otp`, `/login`.

### Frontend: Where to Store the JWT

| Storage | Verdict | Reason |
|---|---|---|
| `localStorage` | ✅ **Used** | Simple, persists across tabs and page reloads. Protected by same-origin policy. Vulnerable to XSS — mitigate by sanitising all user content. |
| `sessionStorage` | ⚠️ Optional | Same XSS risk; token lost on tab close — poor UX. |
| `HttpOnly cookie` | ✅ Most secure | Not accessible from JS — XSS-proof. Requires a same-origin server to set the cookie. Not usable with a pure static frontend calling Supabase Edge Functions directly. |
| In-memory variable | ⚠️ Dev only | Lost on refresh. |

**Current implementation** (`api.js`) stores the token in `localStorage['fcom_token']`.
This is acceptable for a school demo. For a production deployment, consider a thin
backend proxy that sets an `HttpOnly; Secure; SameSite=Strict` cookie.

```javascript
// api.js stores tokens here:
localStorage.setItem('fcom_token',     token);   // long-lived login JWT
localStorage.setItem('fcom_reg_token', regToken); // 1-hour registration JWT
```

**Never** log or transmit the JWT to third-party services.  
The token contains PII (nickname, school).

---

### POST `/functions/v1/approve` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `invalid_json` | 400 | Request body could not be parsed |
| `userId_required` | 400 | `userId` field is missing or blank |
| `unauthorized` / `missing_token` / `token_expired` / `session_revoked` | 401 | JWT missing, invalid, expired, or revoked |
| `server_misconfigured` | 500 | `JWT_SECRET` env var is not set |
| `caller_not_found` | 404 | The authenticated caller no longer exists in DB |
| `forbidden` | 403 | Caller is not `approved` |
| `user_not_found` | 404 | Target user does not exist |
| `cross_school_forbidden` | 403 | Target is in a different school |
| `user_not_pending` | 400 | Target is already approved or rejected |
| `cannot_approve_self` | 400 | Caller tried to approve themselves |
| `approve_failed` | 500 | DB error inside `approve_and_log` RPC |

Success:
```json
{ "ok": true, "user": { "id": "uuid", "status": "approved", "cred": 1 } }
```

---

### POST `/functions/v1/reject` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `invalid_json` | 400 | Request body could not be parsed |
| `userId_required` | 400 | `userId` field is missing or blank |
| `unauthorized` / `missing_token` / `token_expired` / `session_revoked` | 401 | JWT missing, invalid, expired, or revoked |
| `server_misconfigured` | 500 | `JWT_SECRET` env var is not set |
| `caller_not_found` | 404 | The authenticated caller no longer exists in DB |
| `forbidden` | 403 | Caller is not `approved` |
| `user_not_found` | 404 | Target user does not exist |
| `cross_school_forbidden` | 403 | Target is in a different school |
| `user_not_pending` | 400 | Target is not pending (already decided) |
| `cannot_reject_self` | 400 | Caller tried to reject themselves |
| `reject_failed` | 500 | DB error inside `reject_and_log` RPC |

Success:
```json
{ "ok": true, "user": { "id": "uuid", "status": "rejected" } }
```

---

## Approval System — Design Notes

### Access control rules

| Rule | Implementation |
|---|---|
| Must be authenticated | `requireAuthWithRevocation` checks JWT + `sessions` table |
| Must be `approved` | `caller.status !== 'approved'` → 403 |
| Same school only | `target.school !== caller.school` → 403 |
| Cannot act on self | `target.id === caller.id` → 400 |
| Target must be `pending` | `target.status !== 'pending'` → 400 |
| No service_role bypass from browser | service_role key is server-only (Edge Functions only) |

### Audit log (`approval_log` table)

Every approve/reject action is recorded automatically by the PostgreSQL trigger
`trg_log_status_change` on `users.status`. The trigger reads the `app.actor_id`
session variable, which is set by the `approve_and_log` / `reject_and_log` RPCs
(migration 016) **within the same transaction** to ensure the correct caller is logged.

```sql
-- approval_log schema
CREATE TABLE public.approval_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "actorId"  UUID        NOT NULL,   -- who performed the action
  "targetId" UUID        NOT NULL,   -- who was approved/rejected
  action     TEXT        NOT NULL,   -- 'approved' | 'rejected'
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Query a user's full decision history:
```sql
SELECT al.action, al."createdAt",
       actor.nickname  AS actor_nickname,
       target.nickname AS target_nickname
FROM   approval_log al
JOIN   users actor  ON actor.id  = al."actorId"
JOIN   users target ON target.id = al."targetId"
WHERE  al."targetId" = '<uuid>'
ORDER  BY al."createdAt" DESC;
```

### Why `approve_and_log` / `reject_and_log` RPCs?

supabase-js sends each `.from(...).update()` call as an independent HTTP request
with its own implicit transaction. `SET LOCAL "app.actor_id"` would be lost before
the trigger fires. The RPCs in migration 016 wrap the `SET LOCAL` + `UPDATE` in a
single PL/pgSQL function, guaranteeing they run in one transaction.

### Collective approval (future)

The current system requires **1 approved peer in the same school** to approve a
registrant (one-click, mirrors credo.js). If you later want multi-vote approval
(e.g. 3 peers must approve before the account is activated), add an
`approval_votes` table and change the logic inside `approve_and_log` to:

1. INSERT into `approval_votes` (actor, target)
2. COUNT votes for target
3. If `COUNT >= threshold` → UPDATE users SET status = 'approved'

The frontend `Credo.approveUser()` and `api.js` monkey-patch need no changes —
the response would just not include `status: 'approved'` until the threshold is met.

---

## User Status Flow

```
(register)
    │
    ▼
 pending  ──approve──▶  approved  ──(set password)──▶  full access
    │
   reject
    │
    ▼
 rejected  ──▶  device_blocks  ──▶  future registrations blocked
```

First user in a school is auto-approved (via SQL trigger `auto_approve_first`).

---

## Security Notes

- Passwords stored as **PBKDF2-SHA256** (100 000 iterations, 16-byte random salt) — format: `pbkdf2:sha256:100000:<saltHex>:<hashHex>`
  - Note: the module is named `bcrypt.ts` for historical reasons, but the implementation uses the Web Crypto API (`PBKDF2`) — no native bcrypt in Deno Edge runtime
- JWT: HS256, 7-day expiry for login sessions, 1-hour for registration token
- JWT revocation: `jti` claim stored in `sessions` table; all protected functions call `requireAuthWithRevocation()` which verifies the session is still active in the DB
- OTP: 6 digits, 5-minute TTL, previous codes invalidated on resend
- `cred` field: only writable via `apply_cred_delta()` SQL function (`REVOKE ... FROM PUBLIC` enforced)
- RLS policies prevent cross-school data leaks
- Rate limiting: persistent via `rate_limit_log` table (works across all worker instances)
  - `/register`: 5 requests / IP / minute
  - `/login`: 10 requests / IP / minute
  - `/verify-phone` and `/resend-otp`: 3 requests / IP+phone / 10 minutes
- Device fingerprint: SHA-256 of `userAgent + screen + timezone`, blocked on rejection
- CORS: wildcard `*` in development; change `Access-Control-Allow-Origin` in `response.ts` for production

---

### POST `/functions/v1/rate` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `invalid_json` | 400 | Request body could not be parsed |
| `toId_required` | 400 | `toId` / `toUserId` field is missing or blank |
| `fromUserId_mismatch` | 403 | `fromUserId` was provided in the body but does not match the JWT `sub` — client tried to act as another user |
| `invalid_score` | 400 | `score` is not an integer in 1..5 |
| `self` | 400 | `fromId` === `toId` (cannot rate yourself) |
| `rate_limit_exceeded` | 429 | More than 20 requests from the same IP in 60 s |
| `unauthorized` / `missing_token` / `token_expired` / `session_revoked` | 401 | JWT missing, invalid, expired, or revoked |
| `server_misconfigured` | 500 | `JWT_SECRET` env var is not set |
| `user_not_found` | 404 | Rater or target user does not exist |
| `forbidden` | 403 | Rater's account is not `approved` |
| `target_not_approved` | 403 | Target's account is not `approved` |
| `cross_school_forbidden` | 403 | Rater and target are in different schools |
| `no_chat` | 403 | No messages exist between the two users (prerequisite) |
| `24h_limit` | 429 | Already rated this user within the last 24 hours |
| `rate_failed` | 500 | Unexpected DB error inside `rate_and_apply` RPC |

### POST `/functions/v1/rate` — Success Response

```json
{
  "ok": true,
  "entry": {
    "from":           "uuid-of-rater",
    "to":             "uuid-of-target",
    "score":          4,
    "weight":         0.56,
    "baseDelta":      1,
    "effectiveDelta": 0.56,
    "date":           "2026-04-15T12:00:00.000Z"
  },
  "newCred": 13.06
}
```

`effectiveDelta` may be smaller than `rawDelta` (= `baseDelta × weight`) when the
target has already received close to `MAX_DAILY_CHANGE = 5` points today.

---

## Credo System — Architecture & Algorithm

### Subsystem Overview

The "Кредо" trust system assigns each user a numeric reputation score (`cred`).
Higher Credo increases the **influence weight** of ratings that user submits.
The score is fully immutable from the outside — only the `rate_and_apply` SQL
function may update it.

| Component | Location | Purpose |
|---|---|---|
| `cred` column | `users.cred` | Current score — **not directly writable**; REVOKE enforced |
| `rate_log` table | `migrations/005_create_rate_log.sql` | Immutable audit log of every rating |
| `apply_cred_delta()` | `migrations/008_functions_triggers.sql` | Low-level cred writer (used by approve flow) |
| `rate_and_apply()` | `migrations/017_rate_atomic_rpc.sql` | Atomic INSERT rate_log + UPDATE cred |
| `had_conversation()` | `migrations/008_functions_triggers.sql` | Conversation prerequisite check |
| `get_times_rated()` | `migrations/008_functions_triggers.sql` | Repeat-decay counter |
| `get_daily_cred_change()` | `migrations/008_functions_triggers.sql` | Daily volatility cap |
| `enforce_rate_cooldown` trigger | `migrations/012_rate_log_db_constraints.sql` | DB-level 24h cooldown |
| `rate_log_no_self_rate` constraint | `migrations/012_rate_log_db_constraints.sql` | DB-level self-rate prevention |
| `/rate` Edge Function | `supabase/functions/rate/index.ts` | API entry point |

### Cred Levels (from `credo.js`)

| Level | Min | Max | CSS class |
|---|---|---|---|
| Новичок | 0 | 4 | `novice` |
| Знакомый | 5 | 14 | `known` |
| Доверенный | 15 | 29 | `trusted` |
| Свой | 30 | ∞ | `own` |

`cred` is always `≥ 0` (enforced by `GREATEST(0, …)` in `rate_and_apply`).

### Rating Algorithm — Step by Step

**Step 1 — Prerequisite checks**

1. `fromId ≠ toId` — no self-rating (CHECK constraint + app guard)
2. Both users must be `approved` and in the **same school**
3. `had_conversation(from, to)` — at least one message must exist between them
4. 24h cooldown — no rating from same `from → to` in the last 24 hours
   (app-level fast rejection + `enforce_rate_cooldown` trigger as final guard)

**Step 2 — Score → base delta**

```
SCORE_DELTA = { 1: −2,  2: −1,  3: 0,  4: +1,  5: +2 }
baseDelta   = SCORE_DELTA[score]
```

**Step 3 — Weight (anti-abuse)**

```
credWeight:
  rater.cred < 5  → 0.3   (Новичок  — low influence)
  rater.cred < 15 → 0.7   (Знакомый — medium)
  rater.cred ≥ 15 → 1.0   (Доверенный / Свой — full weight)

repeatDecay:
  timesRated  = how many times this rater has previously rated this target
  repeatDecay = max(0.2,  0.8 ^ timesRated)
                ↑ each repeat loses 20%; floor 0.2 prevents total nullification

weight = credWeight × repeatDecay   (rounded to 3 decimal places)
```

**Step 4 — Effective delta (daily volatility cap)**

```
rawDelta       = baseDelta × weight
dailyUsed      = SUM(ABS(effectiveDelta)) for target over last 24 h
remaining      = MAX_DAILY_CHANGE (5) − dailyUsed
effectiveDelta = clamp(rawDelta,  −remaining .. +remaining)
```

The daily cap is **absolute** (sum of magnitudes, not net change), making it
harder to engineer large swings through alternating positive/negative ratings.

**Step 5 — Atomic commit**

```
rate_and_apply(fromId, toId, score, weight, baseDelta, effectiveDelta)
  ├─ INSERT INTO rate_log         ← enforce_rate_cooldown trigger fires in same txn
  └─ UPDATE users SET cred = GREATEST(0, ROUND(cred + effectiveDelta, 2))
  └─ returns new cred value
```

Both writes execute in a **single PostgreSQL transaction**, eliminating the race
condition that would exist if the INSERT and UPDATE were issued as separate calls.
If the trigger raises an exception (concurrent duplicate rating), the entire
transaction rolls back cleanly.

### Abuse Prevention Summary

| Threat | Defence |
|---|---|
| Self-rating | `rate_log."from" <> rate_log."to"` CHECK constraint + app guard |
| Spamming ratings | 24h cooldown per `(from, to)` pair — `enforce_rate_cooldown` trigger |
| Low-cred shill accounts | `credWeight = 0.3` for `cred < 5` |
| Repeat-rating same person | `repeatDecay` decays by 20% per repeat, floor 0.2 |
| Cred spike in one day | `MAX_DAILY_CHANGE = 5` absolute cap per target per 24h |
| Direct `cred` column write | REVOKE enforced; only `apply_cred_delta` / `rate_and_apply` may write |
| Unauthenticated calls | JWT + session revocation check on every request |
| Cross-school voting | `rater.school === target.school` enforced before any calculation |
| Rating without prior contact | `had_conversation()` prerequisite |
| DOS / enumeration | IP rate limit: 20 req / IP / minute |
| Race condition on concurrent ratings | `rate_and_apply` is a single DB transaction; trigger prevents double-entry |

### Frontend Integration Example

```javascript
// Rate a user (from app.js via the Credo.rateUser monkey-patch in api.js)
const result = await API.rateUser(targetUserId, 4);
// result.ok    — true on success
// result.entry — the logged rating entry
// result.newCred — target's updated cred value

// api.js monkey-patch (already in place):
Credo.rateUser = function(fromId, toId, score) {
  const result = _origRate(fromId, toId, score);   // update localStorage
  if (result.ok) {
    _call('/rate', { method: 'POST', body: { toId, score } })
      .catch(e => console.warn('[API] rate backend error:', e));
  }
  return result;
};
```

> `fromId` is **never sent** in the request body. The Edge Function reads it
> from the JWT `sub` claim, so a client cannot rate on behalf of another user.

---

## Messages System — Architecture & API

### Database Schema

```sql
-- messages table (migrations/004 + 014)
CREATE TABLE public.messages (
  id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "fromId" UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "toId"   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text     TEXT        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  time     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "readAt" TIMESTAMPTZ DEFAULT NULL   -- NULL = unread; timestamp = first-read time
);

-- Indexes
-- messages_conversation_idx  ON ("fromId", "toId")  — fetch by direction
-- messages_conversation_rev_idx ON ("toId", "fromId") — reverse
-- messages_time_idx           ON (time)              — ordering
-- messages_unread_idx         ON ("toId", "readAt") WHERE "readAt" IS NULL — unread counts
```

### RLS Policy

```sql
-- Only participants in a conversation may SELECT their messages via direct API
CREATE POLICY "messages_select_participant"
  ON public.messages FOR SELECT
  USING ("fromId" = auth.uid() OR "toId" = auth.uid());

-- No direct INSERT/UPDATE/DELETE — all writes go through Edge Functions (service_role)
```

### SQL Helper Functions (migration 018)

| Function | Returns | Purpose |
|---|---|---|
| `get_unread_counts(user_id)` | `(partner_id, unread_count)[]` | Batch unread count per partner — avoids N calls |
| `conversation_summary(user_id)` | `(partner_id, last_text, last_time, last_from, unread_count)[]` | Chat-list view — one row per conversation |
| `mark_messages_read(reader_id, sender_id)` | `INTEGER` | Mark a partner's messages to me as read; returns count updated |

---

### GET `/functions/v1/messages` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `unauthorized` / `missing_token` / `token_expired` / `session_revoked` | 401 | JWT missing, invalid, expired, or revoked |
| `server_misconfigured` | 500 | `JWT_SECRET` env var not set |
| `caller_not_found` | 404 | Authenticated user no longer exists in DB |
| `forbidden` | 403 | Caller is not `approved` |
| `partnerId_required` | 400 | `partnerId` query param is missing or blank |
| `invalid_before_cursor` | 400 | `before` param is not a valid ISO timestamp |
| `partner_not_found` | 404 | Partner user does not exist |
| `cross_school_forbidden` | 403 | Partner is in a different school |
| `partner_not_approved` | 400 | Partner's account is not yet approved |
| `fetch_failed` | 500 | Unexpected DB error fetching messages |

### GET `/functions/v1/messages` — Success Response

**Default (no pagination)** — all messages, ascending, backward-compatible:
```
GET /functions/v1/messages?partnerId=<uuid>
```
```json
{
  "ok": true,
  "messages": [
    { "id": "uuid", "fromId": "uuid-a", "toId": "uuid-b", "text": "Привет!", "time": "2026-04-15T10:00:00Z", "readAt": "2026-04-15T10:01:00Z" },
    { "id": "uuid", "fromId": "uuid-b", "toId": "uuid-a", "text": "Привет :)", "time": "2026-04-15T10:02:00Z", "readAt": null }
  ],
  "markedRead": 1,
  "hasMore": false
}
```

**Paginated** — latest 50 messages, then scroll up for older:
```
GET /functions/v1/messages?partnerId=<uuid>&limit=50
```
```json
{
  "ok": true,
  "messages": [ ... ],   // ascending, newest 50
  "markedRead": 3,
  "hasMore": true        // there are older messages — pass before= to load them
}
```

**Cursor** — load the next page of older messages:
```
GET /functions/v1/messages?partnerId=<uuid>&limit=50&before=2026-04-15T10:00:00.000Z
```
Pass the `time` of the oldest message in the current page as `before`.

### POST `/functions/v1/messages` — Error Codes

| `error` | HTTP | Meaning |
|---|---|---|
| `unauthorized` / `missing_token` / `token_expired` / `session_revoked` | 401 | JWT issues |
| `server_misconfigured` | 500 | `JWT_SECRET` not set |
| `caller_not_found` | 404 | Caller no longer exists |
| `forbidden` | 403 | Caller not approved |
| `rate_limit_exceeded` | 429 | More than 30 messages from the same IP in 60 s |
| `invalid_json` | 400 | Body could not be parsed |
| `toId_required` | 400 | `toId` missing or blank |
| `text_required` | 400 | `text` missing or blank |
| `text_too_long` | 400 | `text` exceeds 4000 characters |
| `cannot_message_self` | 400 | Sending a message to yourself |
| `recipient_not_found` | 404 | Recipient user does not exist |
| `cross_school_forbidden` | 403 | Recipient is in a different school |
| `recipient_not_approved` | 400 | Recipient is not approved |
| `send_failed` | 500 | Unexpected DB error on INSERT |

### POST `/functions/v1/messages` — Success Response

```json
{
  "ok": true,
  "message": {
    "id":     "uuid",
    "fromId": "uuid-sender",
    "toId":   "uuid-recipient",
    "text":   "Привет!",
    "time":   "2026-04-15T14:30:00.000Z",
    "readAt": null
  }
}
```

---

### Credo Integration: `had_conversation`

The Credo `/rate` endpoint requires that the rater and target have previously exchanged messages. This is enforced by:

```sql
-- had_conversation(id1, id2) — returns TRUE if any message exists between them
SELECT EXISTS (
  SELECT 1 FROM public.messages
  WHERE ("fromId" = id1 AND "toId" = id2)
     OR ("fromId" = id2 AND "toId" = id1)
);
```

The `messages` table is therefore the **single source of truth** for "have these users spoken". No extra "contacts" table is needed.

---

### Frontend Integration

The existing `api.js` monkey-patch covers all write operations automatically:

```javascript
// Already in api.js — no changes needed for basic use
Credo.sendMessage = function(fromId, toId, text) {
  _origSend(fromId, toId, text);                           // update localStorage
  _call('/messages', { method: 'POST', body: { toId, text } });  // sync to backend
};
```

For **paginated loading** (loading older messages as the user scrolls up), add to `api.js`:

```javascript
// Load a specific page of messages — only needed for pagination UI
async function getMessages(partnerId, { limit = 50, before } = {}) {
  let url = `/messages?partnerId=${partnerId}&limit=${limit}`;
  if (before) url += `&before=${encodeURIComponent(before)}`;
  return _call(url);
}
```

For **unread badge counts** on the chat list:

```javascript
// Get unread counts for all conversations in one call
async function getUnreadCounts() {
  // Use the conversation_summary RPC via a dedicated edge function or
  // call the users endpoint which can be extended to include unread counts.
  // Quick approach — call get_unread_counts via supabase-js in local mode:
  const { data } = await supabase.rpc('get_unread_counts', { p_user_id: myId });
  // Returns: [{ partner_id: "uuid", unread_count: 3 }, ...]
}
```

---

### Realtime — Adding Live Message Delivery

Supabase Realtime lets the browser subscribe to new rows in `messages` without polling.

#### Option A — Supabase JS client (simplest)

```javascript
// In your chat screen initialisation
const channel = supabase
  .channel(`chat:${myId}`)
  .on(
    'postgres_changes',
    {
      event:  'INSERT',
      schema: 'public',
      table:  'messages',
      filter: `toId=eq.${myId}`,   // only messages TO me
    },
    (payload) => {
      const msg = payload.new;
      // Push into localStorage chat cache and re-render
      const chatKey = [myId, msg.fromId].sort().join('::');
      const chats   = JSON.parse(localStorage.getItem('credo_chats') || '{}');
      if (!chats[chatKey]) chats[chatKey] = [];
      chats[chatKey].push({ from: msg.fromId, text: msg.text, time: msg.time });
      localStorage.setItem('credo_chats', JSON.stringify(chats));

      // If your app.js has a render function, call it here
      // renderChat(msg.fromId);
    },
  )
  .subscribe();

// Clean up on logout / route change
// channel.unsubscribe();
```

**Prerequisites:**
1. Enable Realtime for the `messages` table in the Supabase dashboard → Database → Replication → `messages` → toggle on.
2. The Supabase JS client must be initialised with the **anon key** (not service_role) for RLS to filter rows — the `messages_select_participant` policy ensures users only receive their own messages.
3. The user must be authenticated via `supabase.auth.signIn` — or use the `Authorization` header approach for custom JWT.

#### Option B — Polling fallback (no setup required)

If Realtime is not enabled, a simple poll every 5 s works for the school demo:

```javascript
let _pollInterval = null;

function startMessagePoll(partnerId, onNew) {
  let lastTime = new Date().toISOString();
  _pollInterval = setInterval(async () => {
    const res = await _call(`/messages?partnerId=${partnerId}&limit=20&before=9999`);
    if (!res.ok) return;
    const fresh = res.messages.filter(m => m.time > lastTime);
    if (fresh.length) {
      lastTime = fresh.at(-1).time;
      onNew(fresh);
    }
  }, 5000);
}

function stopMessagePoll() {
  clearInterval(_pollInterval);
}
```

#### Recommendation

For a school demo, **polling** is the simplest option — no Supabase dashboard changes needed.
For a production app, use **Realtime** (Option A) — it is push-based and does not generate unnecessary DB load.

---

## Security Architecture

### Access Model: Three Roles

| Role | Who uses it | DB access |
|---|---|---|
| `anon` | Browser before login | RLS-filtered SELECT on `users` (nickname, school, status, id only) |
| `authenticated` | Supabase Auth JWT (not used in this project) | Same as anon + extra columns; RLS still applies |
| `service_role` | Edge Functions only | Bypasses RLS — full access to all tables |

> **Important**: This project uses **custom HS256 JWT** (not Supabase Auth). The `auth.uid()` function returns `NULL` for all custom JWTs. This means every RLS policy that references `auth.uid()` evaluates to `FALSE` for frontend requests — direct PostgREST access is completely blocked even before the REVOKE layer kicks in. The RLS policies serve as documentation of intent and as a safety net in case Supabase Auth is ever added.

---

### Table Access Matrix

| Table | anon | authenticated | service_role (Edge Fn) | Notes |
|---|---|---|---|---|
| `users` | SELECT (4 cols) | SELECT (8 cols, RLS) | Full | `passwordHash`, `phone`, `phoneVerified` excluded by column GRANT |
| `users_safe` (view) | — | SELECT (8 cols, RLS) | Full | Safe projection for any future direct API use |
| `messages` | — | SELECT (RLS) | Full | participants only via `messages_select_participant` |
| `rate_log` | — | SELECT (RLS) | Full | from/to only via `rate_log_select_participant` |
| `approval_log` | — | SELECT (RLS) | Full | actor/target only via `approval_log_select_participant` |
| `otp_codes` | ❌ | ❌ | Full | no RLS policies = zero access for non-service_role |
| `sessions` | ❌ | ❌ | Full | same |
| `device_blocks` | ❌ | ❌ | Full | same |
| `rate_limit_log` | ❌ | ❌ | Full | same |

**Write access**: all INSERT/UPDATE/DELETE is REVOKED from `anon` and `authenticated`.  
Every write must go through an Edge Function using `service_role`.

---

### Fields Exposed to Frontend

#### Safe to return from Edge Functions

| Table | Safe columns |
|---|---|
| `users` | `id`, `fullName`, `school`, `grade`, `nickname`, `status`, `cred`, `createdAt` |
| `messages` | `id`, `fromId`, `toId`, `text`, `time`, `readAt` |
| `rate_log` | `id`, `from`, `to`, `score`, `weight`, `baseDelta`, `effectiveDelta`, `date` |
| `approval_log` | `id`, `actorId`, `targetId`, `action`, `createdAt` |

#### Never returned to frontend

| Field | Reason |
|---|---|
| `users.passwordHash` | Credential secret — never exposed, column GRANT removed |
| `users.phone` | PII — only returned to the phone's owner, never to others |
| `users.phoneVerified` | Internal state — not needed by frontend after login |
| `otp_codes.*` | Security codes — table fully blocked |
| `sessions.*` | Session secrets — table fully blocked |
| `device_blocks.*` | Internal blocklist — table fully blocked |
| `rate_limit_log.*` | Internal counters — table fully blocked |

---

### Endpoints That Must Be Edge Functions (Never Direct PostgREST)

| Endpoint | Reason |
|---|---|
| `POST /register` | Inserts user, sends OTP, checks device block — multi-step |
| `POST /verify-phone` | Reads OTP code (blocked table), marks `phoneVerified = true` |
| `POST /resend-otp` | Writes to `otp_codes` (blocked table) |
| `POST /login` | Reads `passwordHash` (blocked column), writes `sessions`, returns JWT |
| `POST /logout` | Deletes from `sessions` (blocked table) |
| `POST /set-password` | Writes `passwordHash` (blocked column) |
| `POST /approve` | Calls `approve_and_log` RPC — requires `app.actor_id` |
| `POST /reject` | Calls `reject_and_log` RPC — requires `app.actor_id`; writes `device_blocks` |
| `POST /rate` | Calls `rate_and_apply` RPC — requires `app.allow_direct_write` |
| `POST /messages` | INSERT into `messages` (write REVOKED from authenticated) |
| `GET /users` | Filters by school, joins safe columns — logic too complex for RLS alone |
| `POST /cleanup` | Deletes expired rows — requires service_role for private tables |

---

### RLS Policies — Full Reference

```sql
-- USERS
-- users_select_own: any authenticated user can read their own full row
USING (id = auth.uid())

-- users_select_approved_same_school: read other approved users in same school
USING (status = 'approved' AND school = (SELECT school FROM users WHERE id = auth.uid()))

-- users_select_pending_same_school: approved users can see pending in same school
USING (status = 'pending'
  AND school = (SELECT school FROM users WHERE id = auth.uid())
  AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND status = 'approved'))

-- MESSAGES
-- messages_select_participant: only from/to can read
USING ("fromId" = auth.uid() OR "toId" = auth.uid())

-- RATE_LOG
-- rate_log_select_participant: only rater/rated can read
USING ("from" = auth.uid() OR "to" = auth.uid())

-- APPROVAL_LOG
-- approval_log_select_participant: actor or target can read
USING ("actorId" = auth.uid() OR "targetId" = auth.uid())

-- FULLY BLOCKED (no policies = no access)
-- otp_codes, sessions, device_blocks, rate_limit_log
```

---

### DB-Level Field Guards (migration 019)

```sql
-- Trigger: guard_cred_and_status
-- Fires BEFORE UPDATE OF cred, status ON users.
-- Raises insufficient_privilege unless app.allow_direct_write = 'true'.
-- Set by: apply_cred_delta(), approve_and_log(), reject_and_log(),
--         rate_and_apply(), auto_approve_first() — all SECURITY DEFINER.
```

Even if `service_role` is somehow misused to run a raw UPDATE, this trigger prevents any change to `cred` or `status` that bypasses the sanctioned functions.

---

### Threat Model & Mitigations

| Threat | Mitigation | Layer |
|---|---|---|
| **Replay registration** | Unique indexes on `nickname` (CI), `fullName` (CI), `phone` (partial) | DB constraint |
| **Brute-force OTP** | Max 5 attempts per code + `attempts` column; 3 resends / 10 min per IP+phone | App + DB |
| **OTP timing attack** | Constant-time comparison in `verify-phone` | App (Edge Fn) |
| **Brute-force login** | 10 req / IP / min; generic `invalid_credentials` error (no user enumeration) | App rate limit |
| **fromUserId spoofing** | `fromId` always from JWT `sub`; body `fromUserId` validated against JWT | App (Edge Fn) |
| **sender spoofing in messages** | `fromId` always from JWT `sub`; no body field accepted | App (Edge Fn) |
| **Direct `cred` modification** | REVOKE on `apply_cred_delta`; `guard_cred_and_status` trigger | DB function + trigger |
| **Direct `status` modification** | `guard_cred_and_status` trigger; only `approve_and_log`/`reject_and_log` permitted | DB trigger |
| **Cross-school data leak** | `school` check in every Edge Function + RLS policies | App + RLS |
| **Mass Credo farming** | Weight system (credWeight × repeatDecay); daily cap (MAX_DAILY_CHANGE=5); 24h cooldown | App + DB trigger |
| **Rating without prior contact** | `had_conversation()` prerequisite check | App + DB function |
| **Race condition on ratings** | `rate_and_apply` atomically inserts rate_log + updates cred in one transaction | DB RPC |
| **Race condition on 24h cooldown** | `enforce_rate_cooldown` trigger fires inside `rate_and_apply` transaction | DB trigger |
| **JWT forgery** | HS256 with 32+ char secret (`JWT_SECRET` env var) | JWT library |
| **JWT theft / session persistence after logout** | `sessions` table + `requireAuthWithRevocation()` — `jti` revocation on logout | App + DB |
| **JWT replay after expiry** | `exp` claim checked; 7-day TTL for login, 1h for registration | JWT library |
| **SQL injection** | Supabase-js parameterised queries; RPC arguments are typed | DB driver |
| **Re-registration after rejection** | SHA-256 device fingerprint stored in `device_blocks`; checked on `/register` | App + DB |
| **Duplicate device block** | `ON CONFLICT (fingerprint) DO NOTHING` in `reject_and_log` | DB |
| **Unauthorised approval/rejection** | Caller must be `approved`; same school; cannot act on self | App (Edge Fn) |
| **Unauthenticated API access** | All protected routes call `requireAuthWithRevocation()` first | App (Edge Fn) |
| **Direct PostgREST table access** | `auth.uid()=NULL` for custom JWT + explicit REVOKE INSERT/UPDATE/DELETE | RLS + GRANT |
| **Sensitive column leakage** (passwordHash, phone) | Column-level GRANT strips these from `anon`/`authenticated`; `users_safe` view | DB GRANT |
| **passwordHash exposure in API** | Edge Functions never SELECT `passwordHash` outside `/login`; column blocked | App + GRANT |
| **DOS via POST /messages** | 30 req / IP / min rate limit | App rate limit |
| **DOS via POST /rate** | 20 req / IP / min rate limit | App rate limit |
| **DOS via POST /register** | 5 req / IP / min rate limit | App rate limit |
| **CORS misconfiguration** | Wildcard `*` in dev; set `ALLOWED_ORIGIN` env var to your domain in prod | App config |
| **Secret leakage** | All secrets in Supabase Edge Function env vars; never hardcoded | Deployment |

---

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | **Yes** | HS256 signing key — minimum 32 random characters. Rotate to revoke all sessions. |
| `CLEANUP_SECRET` | **Yes** | Authenticates `POST /cleanup` — prevents unauthorized data deletion. |
| `SUPABASE_URL` | Auto-set | Injected by Supabase runtime. Do not set manually. |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set | Injected by Supabase runtime. **Never expose to frontend.** |
| `SMS_API_URL` | No | Your SMS provider endpoint. If unset, OTP is returned in the response (dev mode only). |
| `SMS_API_KEY` | No | Your SMS provider API key. |
| `ALLOWED_ORIGIN` | No (prod: Yes) | CORS origin. Defaults to `*`. Set to `https://your-domain.com` in production. |

**How to set secrets (CLI):**
```bash
supabase secrets set JWT_SECRET=$(openssl rand -base64 48)
supabase secrets set CLEANUP_SECRET=$(openssl rand -base64 32)
supabase secrets set ALLOWED_ORIGIN=https://your-app.vercel.app
```

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **automatically injected** by the Supabase Edge Functions runtime. You do not need to set them — and you must never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.

---

### Roles Recommendations

| Operation | Allowed roles | Notes |
|---|---|---|
| Register, verify OTP, login | Public (no auth) | Rate-limited by IP |
| Read own profile | `authenticated` (via Edge Fn) | JWT sub = own id |
| Read other approved users | `authenticated` (via Edge Fn) | Same school only |
| Send/receive messages | `authenticated` (via Edge Fn) | Both approved, same school |
| Approve/reject users | `authenticated`, status = `approved` | Same school, not self |
| Rate a user | `authenticated`, status = `approved` | Conversation prerequisite |
| Admin operations (cleanup) | `CLEANUP_SECRET` bearer | Not a user JWT |
| Direct DB access | `service_role` only | Edge Functions via Supabase runtime |

There is currently **no admin role** separate from `approved` users.

---

## Frontend–Backend Compatibility Map

### Architecture overview

```
index.html  →  credo.js (localStorage engine)
                    ↑  monkey-patched write methods
            →  api.js  (bridge — this file is the adaptation layer)
                    ↕  fetch() to Supabase Edge Functions
            →  app.js  (UI, reads Credo.* directly — unchanged)
```

Loading order: `credo.js → api.js → app.js`

`api.js` patches `Credo` **before** `app.js`'s `DOMContentLoaded` fires, so every `Credo.approveUser`, `Credo.rateUser`, `Credo.sendMessage` call in `app.js` automatically reaches the backend. `app.js` has no direct knowledge of the backend.

---

### Full API Map

All Edge Functions are at `https://<project>.supabase.co/functions/v1/<name>`.  
`FUNCTIONS_BASE` in `api.js` expands to this base URL automatically.

#### Public endpoints (no JWT required)

| Method | Path | Body | Called by | Notes |
|---|---|---|---|---|
| `POST` | `/register` | `{fullName, school, grade, nickname, phone, deviceFingerprint}` | `API.register()` | Returns `{ok, user, token, _devOtp?}` |
| `POST` | `/verify-phone` | `{phone, code}` | `API.verifyPhone()` | Returns `{ok, userId?}` or `{ok, attemptsLeft}` |
| `POST` | `/resend-otp` | `{phone}` | `API.resendOtp()` | Returns `{ok, _devOtp?}` |
| `POST` | `/login` | `{nickname, password}` | `API.login()` | Returns `{ok, token, user}` |

#### Protected endpoints (Bearer JWT required)

| Method | Path | Body | Called by | Notes |
|---|---|---|---|---|
| `POST` | `/logout` | — | `API.logout()` | Deletes session row; clears local JWTs |
| `POST` | `/set-password` | `{password}` | `API.setPassword()` | Uses registration token (1h TTL) |
| `POST` | `/approve` | `{userId}` | `Credo.approveUser()` monkey-patch | Returns `{ok, user:{id,status,cred}}` |
| `POST` | `/reject` | `{userId, deviceFingerprint}` | `Credo.rejectUser()` monkey-patch | Returns `{ok, user:{id,status}}` |
| `POST` | `/rate` | `{toId, score}` | `Credo.rateUser()` monkey-patch | Returns `{ok, entry, newCred}` |
| `POST` | `/messages` | `{toId, text}` | `Credo.sendMessage()` monkey-patch | Returns `{ok, message}` |
| `GET`  | `/messages?partnerId=<uuid>` | — | `_syncFromServer()` | Returns `{ok, messages, markedRead, hasMore}` |
| `GET`  | `/users` | — | `_syncFromServer()` | Returns `{ok, users, pending}` |

---

### Field Names — Frozen Contract

These field names are used by `credo.js`, `app.js`, and the DB schema. **Never rename them.**

| Field | Type | Where used |
|---|---|---|
| `id` | UUID string | All objects — primary key |
| `fullName` | string | `users` table, registration form, profile display |
| `school` | string | `users` table, cross-school isolation |
| `grade` | string | `users` table, profile display |
| `nickname` | string | `users` table, login, JWT payload |
| `phone` | string / null | `users` table, OTP flow |
| `phoneVerified` | boolean | `users` table, login guard |
| `passwordHash` | string / null | `users` table (never returned to frontend in backend mode) |
| `status` | `"pending"` / `"approved"` / `"rejected"` | `users` table, `route()` routing |
| `cred` | number | `users` table, Credo levels, rating weight |
| `createdAt` | ISO timestamp | `users` table |
| `ratings` | array | localStorage only (`credo_users`) — not stored in DB |
| `chats` | array | localStorage only (`credo_users`) — not stored in DB |

---

### Fetch Examples — Direct Use

These show what `api.js` does internally. You do not need to copy them — `API.*` methods handle everything.

```javascript
const BASE = 'https://vzjlhiqvfgrrlfdgyebx.supabase.co/functions/v1';

// ── Registration ──────────────────────────────────────────────────────────────
const regRes = await fetch(`${BASE}/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    fullName: 'Иванов Иван Иванович',
    school:   'Школа №1',
    grade:    '9А',
    nickname: 'ivan',
    phone:    '+79001234567',
    deviceFingerprint: '<sha256>',
  }),
}).then(r => r.json());
// → { ok: true, user: {...}, token: "<reg-jwt>", _devOtp: "482951" }

// ── Login ─────────────────────────────────────────────────────────────────────
const loginRes = await fetch(`${BASE}/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'ivan', password: 'secret' }),
}).then(r => r.json());
// → { ok: true, token: "<session-jwt>", user: { id, fullName, nickname, status, cred, ... } }

const TOKEN = loginRes.token;
const AUTH  = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// ── Approve a user ────────────────────────────────────────────────────────────
await fetch(`${BASE}/approve`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ userId: '<target-uuid>' }),
}).then(r => r.json());
// → { ok: true, user: { id, status: "approved", cred: 1 } }

// ── Send a message ────────────────────────────────────────────────────────────
await fetch(`${BASE}/messages`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ toId: '<partner-uuid>', text: 'Привет!' }),
}).then(r => r.json());
// → { ok: true, message: { id, fromId, toId, text, time, readAt: null } }

// ── Fetch conversation ────────────────────────────────────────────────────────
const msgsRes = await fetch(`${BASE}/messages?partnerId=<partner-uuid>`, {
  headers: AUTH,
}).then(r => r.json());
// → { ok: true, messages: [...], markedRead: 1, hasMore: false }

// ── Rate a user ───────────────────────────────────────────────────────────────
await fetch(`${BASE}/rate`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ toId: '<target-uuid>', score: 4 }),
}).then(r => r.json());
// → { ok: true, entry: { from, to, score, weight, baseDelta, effectiveDelta, date }, newCred: 13.7 }

// ── Logout ────────────────────────────────────────────────────────────────────
await fetch(`${BASE}/logout`, {
  method: 'POST', headers: AUTH,
}).then(r => r.json());
// → { ok: true }
```

---

### Error Response Format

All endpoints return a uniform shape on failure:

```json
{ "ok": false, "error": "<error_code>" }
```

Some errors carry additional fields:

```json
{ "ok": false, "error": "invalid_code", "attemptsLeft": 3 }
```

Error codes are stable English strings — see each endpoint's error table in the sections above. `app.js` maps them to Russian messages via lookup objects:

```javascript
// Example from app.js — do not change keys
const LOGIN_ERRORS = {
  invalid_credentials:  'Неверный никнейм или пароль.',
  account_not_approved: 'Аккаунт ещё не одобрен другими участниками.',
  account_rejected:     'Аккаунт отклонён. Вход невозможен.',
  phone_not_verified:   'Сначала подтвердите номер телефона.',
  rate_limit_exceeded:  'Слишком много попыток. Подождите немного.',
};
```

---

### JWT Lifecycle in Frontend

```
Register → fcom_reg_token (1h)  → set-password
                                → discard after use
Login    → fcom_token (7 days)  → all protected calls
                                → deleted on logout
```

Both tokens live in `localStorage`. The `_call()` helper reads them automatically:

```javascript
// api.js — _call() attaches the correct token
const token = useRegToken ? (getRegToken() || getToken()) : getToken();
if (token) headers['Authorization'] = `Bearer ${token}`;
```

`useRegToken: true` is only passed for `POST /set-password`. All other protected calls use the session token.

---

### URL Format Difference

Supabase Edge Functions are served at `/functions/v1/<name>`, not `/api/<name>` or `/<name>`. `api.js` handles this transparently:

```javascript
// api.js — line 28
const FUNCTIONS_BASE = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : null;

// Every call:
fetch(`${FUNCTIONS_BASE}/login`, ...)    // → /functions/v1/login
fetch(`${FUNCTIONS_BASE}/register`, ...) // → /functions/v1/register
```

`app.js` never constructs URLs — it calls `API.*` methods or `Credo.*` methods. No URL changes needed in `app.js`.

---

### What Must Not Be Changed

| File / Location | Why |
|---|---|
| `credo.js` — entire file | localStorage engine; `app.js` depends on all its methods |
| `index.html` — screen IDs (`screen-*`) | `app.js` uses `showScreen('name')` by exact string |
| `index.html` — field IDs (`#reg-fullname`, `#login-nickname`, etc.) | `app.js` reads them directly with `$('#id').value` |
| `index.html` — button IDs (`#login-btn`, `#rate-submit-btn`, etc.) | event listeners in `app.js` `init()` bind to these |
| `app.js` — field name references (`user.fullName`, `user.cred`, `user.status`, etc.) | Must match DB column names exactly |
| `app.js` — `route()` logic | Status-based routing (`pending → approved → setPassword`) must remain intact |
| `app.js` — `REGISTER_ERRORS` / `LOGIN_ERRORS` / `VERIFY_ERRORS` keys | Must match error codes returned by Edge Functions |
| `api.js` — `SUPABASE_URL` | Only value that needs changing when switching projects |
| `api.js` — localStorage keys (`fcom_token`, `fcom_reg_token`, `credo_users`, `credo_chats`) | Shared between `credo.js` and `api.js` |

---

### Minimal Changes Already Made (Blocks 1–12)

| File | What changed | Why |
|---|---|---|
| `api.js` | Added: `logout()`, `verifyPhone()`, `resendOtp()`, `_syncFromServer()`, `_patchCredo()`, JWT storage | Core bridge to backend |
| `api.js` | Removed: debug `fetch()` to localhost:7873 | Cleanup — development artifacts |
| `app.js` | Added: `handleVerifyPhone()`, `handleResendOtp()`, `screen-verify-phone` logic | OTP verification screen |
| `app.js` | Updated: `handleLogin()` error messages, `handleDemoLogout()` / `handleDemoReset()` call `API.logout()` | Backend-aware logout |
| `app.js` | Removed: debug `fetch()` to localhost:7873 | Cleanup — development artifacts |
| `index.html` | Added: `<input id="reg-phone">`, `<section id="screen-verify-phone">` | Phone field + OTP screen |

`credo.js` and all HTML structure: **unchanged**. Every approved peer in a school can approve or reject new registrants. If you need a dedicated admin (e.g., a teacher account), add a `role TEXT CHECK (role IN ('user', 'admin'))` column to `users` and gate `/approve`, `/reject` on `role = 'admin'`.
