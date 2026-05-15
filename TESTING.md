# Fcom — Backend Testing Plan

Complete test cases for every endpoint, security layer, and business rule.

---

## Test Environment Setup

Before running tests, ensure:
- All 19 migrations applied to a clean database
- `supabase/seed.sql` applied (provides known users for tests)
- Edge Functions deployed
- `JWT_SECRET` set, `SMS_API_URL` empty (dev OTP mode active)

Seed password:
- All seeded users use the shared password `testpass`

### Seed user reference

| Nickname | UUID suffix | Status | cred | Notes |
|---|---|---|---|---|
| `alice` | `…000001` | approved | 42.50 | High-cred, has messages with bob/carol |
| `bob` | `…000002` | approved | 18.00 | Has messages with alice |
| `carol` | `…000003` | approved | 5.75 | Has messages with alice |
| `dave` | `…000004` | pending | 0 | Password `testpass`, phone not verified |
| `eve` | `…000005` | rejected | 0 | Blocked |
| `frank` | `…000006` | approved | 1.00 | School №2, isolated |
| `grace` | `…000007` | pending | 0 | School №2 |

---

## Test Cases

### Module R — Registration (`POST /register`)

| ID | Scenario | Input | Expected response | Expected HTTP |
|---|---|---|---|---|
| R-01 | Happy path — without phone | `{fullName, school, grade, nickname}` | `{ok:true, user:{status:"pending"}, token}` | 200 |
| R-02 | Happy path — with phone (dev mode) | `{…, phone:"+79009999999"}` | `{ok:true, user, token, _devOtp:"6digits"}` | 200 |
| R-03 | First user in a new school | New school name | `user.status === "approved"` (auto-approved) | 200 |
| R-04 | Missing `fullName` | omit fullName | `{ok:false, error:"fullName_required"}` | 400 |
| R-05 | Missing `school` | omit school | `{ok:false, error:"school_required"}` | 400 |
| R-06 | Missing `grade` | omit grade | `{ok:false, error:"grade_required"}` | 400 |
| R-07 | Missing `nickname` | omit nickname | `{ok:false, error:"nickname_required"}` | 400 |
| R-08 | Duplicate nickname — exact | `nickname:"alice"` | `{ok:false, error:"nickname_taken"}` | 400 |
| R-09 | Duplicate nickname — case-insensitive | `nickname:"ALICE"` | `{ok:false, error:"nickname_taken"}` | 400 |
| R-10 | Duplicate phone | `phone:"+79001000001"` (alice's) | `{ok:false, error:"phone_taken"}` | 400 |
| R-11 | Duplicate fullName — exact | `fullName:"Иванова Алиса Сергеевна"` | `{ok:false, error:"fullName_taken"}` | 400 |
| R-12 | Duplicate fullName — case-insensitive | `fullName:"иванова алиса сергеевна"` | `{ok:false, error:"fullName_taken"}` | 400 |
| R-13 | Blocked device fingerprint | `deviceFingerprint` of a rejected user | `{ok:false, error:"device_blocked"}` | 403 |
| R-14 | Rate limit — 6th request from same IP in 1 min | Repeat 6 times | `{ok:false, error:"rate_limit_exceeded"}` | 429 |
| R-15 | Invalid JSON body | `body: "garbage"` | `{ok:false, error:"invalid_json"}` | 400 |
| R-16 | Phone with spaces/formatting | `phone:" +7 900 999 99 99 "` | Accepted — trimmed; no error | 200 |
| R-17 | Registered user gets `phoneVerified:false` | With phone | `user.phoneVerified === false` | 200 |
| R-18 | Registration token issued | Happy path | `token` is a valid JWT | 200 |

---

### Module O — OTP Verification

#### `POST /verify-phone`

| ID | Scenario | Input | Expected response | Expected HTTP |
|---|---|---|---|---|
| O-01 | Correct code | `{phone, code:_devOtp}` | `{ok:true}` | 200 |
| O-02 | Dev universal bypass | `{phone, code:"000000"}` | `{ok:true}` (when SMS_API_URL not set) | 200 |
| O-03 | Wrong code — first attempt | `{phone, code:"999999"}` | `{ok:false, error:"invalid_code", attemptsLeft:4}` | 400 |
| O-04 | Wrong code — max attempts (5) | Wrong code 5 times | `{ok:false, error:"too_many_attempts"}` | 429 |
| O-05 | OTP already used | Replay valid code | `{ok:false, error:"otp_not_found_or_expired"}` | 400 |
| O-06 | Expired OTP | Code inserted with past `expiresAt` | `{ok:false, error:"otp_not_found_or_expired"}` | 400 |
| O-07 | Unknown phone | Phone not in otp_codes | `{ok:false, error:"user_not_found"}` | 404 |
| O-08 | `phoneVerified` becomes true after success | Check DB after O-01 | `users."phoneVerified" = true` for user | — |
| O-09 | OTP marked used after success | Check DB after O-01 | `otp_codes.used = true` | — |
| O-10 | Rate limit | 11 requests/IP/min | `{ok:false, error:"rate_limit_exceeded"}` | 429 |

#### `POST /resend-otp`

| ID | Scenario | Input | Expected response | Expected HTTP |
|---|---|---|---|---|
| O-11 | Resend for valid phone | `{phone}` | `{ok:true, _devOtp:"6digits"}` | 200 |
| O-12 | Previous OTP invalidated | After O-11, old code | `{ok:false, error:"otp_not_found_or_expired"}` | 400 |
| O-13 | Phone not registered | Unknown phone | `{ok:false, error:"user_not_found"}` | 404 |
| O-14 | Already verified phone | alice's phone | `{ok:false, error:"already_verified"}` | 400 |

---

### Module P — Set Password (`POST /set-password`)

| ID | Scenario | Input | Expected response | Expected HTTP |
|---|---|---|---|---|
| P-01 | Happy path with reg token | `{password:"abc123"}` + `Authorization: Bearer <regToken>` | `{ok:true}` | 200 |
| P-02 | No token | No Authorization header | `{ok:false, error:"unauthorized"}` | 401 |
| P-03 | Wrong token (random string) | `Bearer bad_token` | `{ok:false, error:"unauthorized"}` | 401 |
| P-04 | Missing password | `{}` + valid reg token | `{ok:false, error:"password_required"}` | 400 |
| P-05 | Empty password string | `{password:""}` | `{ok:false, error:"password_required"}` | 400 |
| P-06 | Password too short (< 6 chars) | `{password:"abc"}` | `{ok:false, error:"password_too_short"}` | 400 |
| P-07 | Reg token valid 1 h | Wait > 1h, retry | `{ok:false, error:"unauthorized"}` | 401 |
| P-08 | Session token works too | Session JWT from login | `{ok:true}` (password re-set) | 200 |

---

### Module L — Login (`POST /login`)

| ID | Scenario | Input | Expected response | Expected HTTP |
|---|---|---|---|---|
| L-01 | Happy path — approved user | `{nickname:"alice", password:"…"}` | `{ok:true, token:"…", user:{id,fullName,…}}` | 200 |
| L-02 | Wrong password | `{nickname:"alice", password:"wrong"}` | `{ok:false, error:"invalid_credentials"}` | 401 |
| L-03 | Wrong nickname | `{nickname:"unknown", password:"…"}` | `{ok:false, error:"invalid_credentials"}` | 401 |
| L-04 | Pending user | `{nickname:"dave", …}` | `{ok:false, error:"account_not_approved"}` | 403 |
| L-05 | Rejected user | `{nickname:"eve", …}` | `{ok:false, error:"account_rejected"}` | 403 |
| L-06 | Phone not verified | User with `phoneVerified:false` | `{ok:false, error:"phone_not_verified"}` | 403 |
| L-07 | No password set yet | User with `passwordHash:null` | `{ok:false, error:"invalid_credentials"}` | 401 |
| L-08 | Rate limit — 6th attempt | 6 login attempts/IP/min | `{ok:false, error:"rate_limit_exceeded"}` | 429 |
| L-09 | JWT returned is valid | Parse the token | `sub` = userId, `nickname`, `status`, `school` in payload | — |
| L-10 | Session stored in DB | After L-01 | Row in `sessions` for the `jti` | — |

---

### Module A — Approve / Reject

#### `POST /approve`

| ID | Scenario | Actor → Target | Expected response | Expected HTTP |
|---|---|---|---|---|
| A-01 | Happy path | alice → dave | `{ok:true, user:{status:"approved", cred:1}}` | 200 |
| A-02 | Pending user tries to approve | dave → dave | `{ok:false, error:"insufficient_permissions"}` | 403 |
| A-03 | Rejected user tries to approve | eve → dave | `{ok:false, error:…}` (unauthorized/rejected) | 403 |
| A-04 | No JWT | — | `{ok:false, error:"unauthorized"}` | 401 |
| A-05 | Non-existent target | alice → unknown-uuid | `{ok:false, error:"target_not_found"}` | 404 |
| A-06 | Already approved target | alice → alice | `{ok:false, error:"target_not_pending"}` | 400 |
| A-07 | Log entry created | After A-01 | Row in `approval_log` with correct `actorId` | — |
| A-08 | First user in school auto-approved | New school registration | `status:"approved"` without needing `/approve` | — |

#### `POST /reject`

| ID | Scenario | Actor → Target | Expected response | Expected HTTP |
|---|---|---|---|---|
| A-09 | Happy path | alice → dave | `{ok:true, user:{status:"rejected"}}` | 200 |
| A-10 | Reject with device fingerprint | `{userId, deviceFingerprint:"…"}` | Row in `device_blocks` | 200 |
| A-11 | Rejected user cannot log in | After A-09 | Login returns `account_rejected` | — |
| A-12 | Rejected user's device blocked | After A-10 | Register returns `device_blocked` | — |
| A-13 | Pending user tries to reject | dave → dave | `{ok:false, error:"insufficient_permissions"}` | 403 |
| A-14 | Log entry with actor | After A-09 | `approval_log.actorId` = alice's id | — |

---

### Module M — Messages

#### `POST /messages`

| ID | Scenario | Input | Expected response | Expected HTTP |
|---|---|---|---|---|
| M-01 | Happy path — send message | `{toId: bob.id, text:"Hi"}` + alice's JWT | `{ok:true, message:{id,fromId,toId,text,time}}` | 200 |
| M-02 | No JWT | `{toId, text}` | `{ok:false, error:"unauthorized"}` | 401 |
| M-03 | Empty text | `{toId, text:""}` | `{ok:false, error:"text_required"}` | 400 |
| M-04 | Whitespace-only text | `{toId, text:"   "}` | `{ok:false, error:"text_required"}` | 400 |
| M-05 | Missing `toId` | `{text:"Hi"}` | `{ok:false, error:"toId_required"}` | 400 |
| M-06 | Send to pending user | alice → dave | `{ok:false, error:"…"}` (partner must be approved) | 403 |
| M-07 | Cross-school message | alice → frank | `{ok:false, error:"cross_school_forbidden"}` | 403 |
| M-08 | `fromId` is always from JWT | Body contains `fromId: bob.id` but alice's token | `message.fromId` === alice's id (body ignored) | 200 |
| M-09 | Rate limit | 31 messages/IP/min | `{ok:false, error:"rate_limit_exceeded"}` | 429 |
| M-10 | `readAt` is null on send | Check response | `message.readAt === null` | 200 |

#### `GET /messages`

| ID | Scenario | Query | Expected response | Expected HTTP |
|---|---|---|---|---|
| M-11 | Get conversation | `?partnerId=bob.id` + alice's JWT | `{ok:true, messages:[…], hasMore, markedRead}` | 200 |
| M-12 | Messages sorted ascending | Check order | `messages[0].time < messages[N].time` | 200 |
| M-13 | Only own conversation | `?partnerId=alice.id` with carol's JWT | Only carol↔alice messages, not alice↔bob | 200 |
| M-14 | No JWT | `?partnerId=…` | `{ok:false, error:"unauthorized"}` | 401 |
| M-15 | Unread messages marked read | Bob gets messages from alice | `markedRead > 0` on first fetch | 200 |
| M-16 | Pagination — `before` cursor | `?partnerId=…&limit=2&before=<iso>` | `messages.length <= 2`, `hasMore` correct | 200 |
| M-17 | Missing `partnerId` | `GET /messages` | `{ok:false, error:"partnerId_required"}` | 400 |
| M-18 | `had_conversation` is true | After M-01 | `had_conversation(alice,bob)` RPC returns true | — |

---

### Module C — Credo Rating (`POST /rate`)

| ID | Scenario | Input | Expected response | Expected HTTP |
|---|---|---|---|---|
| C-01 | Happy path — first rating | alice → bob, score 5 | `{ok:true, entry:{…}, newCred}` | 200 |
| C-02 | Self-rate | `{toId: alice.id}` with alice's JWT | `{ok:false, error:"self"}` | 400 |
| C-03 | No conversation | New users, no messages | `{ok:false, error:"no_chat"}` | 403 |
| C-04 | 24h cooldown (after C-01) | alice → bob again | `{ok:false, error:"24h_limit"}` | 429 |
| C-05 | Score 0 | `{score:0}` | `{ok:false, error:"invalid_score"}` | 400 |
| C-06 | Score 6 | `{score:6}` | `{ok:false, error:"invalid_score"}` | 400 |
| C-07 | Score non-integer | `{score:3.5}` | `{ok:false, error:"invalid_score"}` | 400 |
| C-08 | `fromUserId` mismatch | Body `fromUserId:bob.id`, alice's JWT | `{ok:false, error:"fromUserId_mismatch"}` | 403 |
| C-09 | Cross-school rating | alice → frank | `{ok:false, error:"cross_school_forbidden"}` | 403 |
| C-10 | Rate pending user | alice → dave | `{ok:false, error:"target_not_approved"}` | 403 |
| C-11 | Rate rejected user | alice → eve | `{ok:false, error:"target_not_approved"}` | 403 |
| C-12 | No JWT | `{toId, score}` | `{ok:false, error:"unauthorized"}` | 401 |
| C-13 | Weight reflects rater cred | alice (cred=42) vs carol (cred=5) | alice's effectiveDelta > carol's for same score | — |
| C-14 | Daily limit enforced | Many raters → same target in 24h | effectiveDelta clamped, total ≤ MAX_DAILY_CHANGE | — |
| C-15 | Legacy `toId` field accepted | `{toId: bob.id, score:4}` | `{ok:true, …}` (backward compat) | 200 |
| C-16 | Optional `fromUserId` matches JWT | `{fromUserId: alice.id, toId: bob.id}` | `{ok:true, …}` | 200 |

---

### Module S — Security

#### Authentication bypass

| ID | Scenario | Method | Expected |
|---|---|---|---|
| S-01 | No Authorization header | Any protected endpoint | `401 unauthorized` |
| S-02 | `Bearer ` with empty token | Any protected endpoint | `401 unauthorized` |
| S-03 | Malformed JWT (wrong format) | Any protected endpoint | `401 unauthorized` |
| S-04 | JWT signed with wrong secret | Any protected endpoint | `401 unauthorized` |
| S-05 | JWT `exp` in the past | Any protected endpoint | `401 unauthorized` |
| S-06 | JWT `jti` revoked (after logout) | Any protected endpoint | `401 unauthorized` |
| S-07 | JWT from different environment | Different `JWT_SECRET` | `401 unauthorized` |

#### Direct DB manipulation prevention

| ID | Scenario | How to test | Expected |
|---|---|---|---|
| S-08 | Direct `UPDATE users SET cred = 99` | Supabase SQL editor / anon key | `ERROR: Direct update of users.cred is forbidden` |
| S-09 | Direct `UPDATE users SET status = 'approved'` | SQL editor | `ERROR: Direct update of users.status is forbidden` |
| S-10 | Direct `INSERT INTO otp_codes` via PostgREST | `fetch('…/rest/v1/otp_codes', {method:'POST',…})` | `403 permission denied` |
| S-11 | Direct `SELECT` on `otp_codes` via PostgREST | `fetch('…/rest/v1/otp_codes')` | `403 permission denied` |
| S-12 | Direct `SELECT` on `sessions` via PostgREST | `fetch('…/rest/v1/sessions')` | `403 permission denied` |
| S-13 | Direct `SELECT` on `device_blocks` | PostgREST with anon key | `403 permission denied` |
| S-14 | Direct `SELECT` on `rate_limit_log` | PostgREST with anon key | `403 permission denied` |
| S-15 | Read another user's `passwordHash` | `fetch('…/rest/v1/users?select=passwordHash')` | Field not returned (column-level grant) |
| S-16 | Read another user's `phone` via PostgREST | `?select=phone` | Field not returned |

#### RLS isolation

| ID | Scenario | How to test | Expected |
|---|---|---|---|
| S-17 | User reads only own messages | alice fetches `GET /messages?partnerId=bob.id` | Only alice↔bob messages, not bob↔carol |
| S-18 | User cannot read others' messages via RLS | PostgREST `/rest/v1/messages` with alice's JWT | Only rows where `fromId` or `toId` = alice.id |
| S-19 | Users view filtered by school | PostgREST `/rest/v1/users` | No cross-school data leakage (if school RLS added) |
| S-20 | Pending user cannot approve | dave calls `/approve` | `403 insufficient_permissions` |
| S-21 | Rejected user cannot use API | eve calls any protected endpoint | Blocked at login; JWT never issued |
| S-22 | Spoofed `fromId` in message body | POST `/messages` with `fromId: bob.id` in body | `message.fromId` = alice.id (JWT wins) |

---

## Race Condition Tests

These require concurrent requests; use Postman's Runner or a script.

### RC-01 — Concurrent registration with same nickname

```
Send 5 simultaneous POST /register requests with the same nickname.
Expected: exactly 1 succeeds (ok:true), others return nickname_taken.
Verify: only 1 row in users with that nickname.
```

### RC-02 — Concurrent rating (24h cooldown bypass attempt)

```
Login as alice. Send 10 simultaneous POST /rate requests (alice → bob).
Expected: exactly 1 succeeds. Others return 24h_limit.
Verify: only 1 row in rate_log for (alice, bob) in the last 24h.
Mechanism: app-level check catches most; enforce_rate_cooldown trigger is the final guard.
```

### RC-03 — Concurrent approval

```
Two approved users both approve the same pending user simultaneously.
Expected: both may succeed (no business rule prevents it) OR second returns an error.
Verify: approval_log has 2 entries, user.status = 'approved', cred = 2 (or 1).
```

### RC-04 — Concurrent cred updates via rate_and_apply

```
10 different users all rate the same target simultaneously.
Expected: all succeed (different raters), cred updates correctly.
Verify: users.cred matches SUM of effectiveDeltas (within daily limit).
No partial updates (atomicity guaranteed by rate_and_apply transaction).
```

---

## Business Logic Edge Cases

### BL-01 — First user in school is auto-approved

```
Register user in a brand new school name (no other users).
Expected: user.status = 'approved', user.cred = 1 (set by auto_approve_first trigger).
Verify: no /approve call needed.
```

### BL-02 — cred never goes below 0

```
Rate target with minimum score repeatedly until effectiveDelta would make cred negative.
Expected: users.cred >= 0 always (GREATEST(0, ...) in apply_cred_delta).
```

### BL-03 — Daily cred change limit (MAX_DAILY_CHANGE = 5)

```
Multiple users all rate the same target with score 5 on the same day.
Expected: total cred change for target <= 5 in 24h.
Check: get_daily_cred_change(target.id) returns <= 5.
```

### BL-04 — Repeat decay on ratings

```
Alice rates Bob 3 times over 3 different days.
Expected: each subsequent rating has lower weight (0.8^timesRated).
After 5 ratings: weight floor = 0.2 (minimum).
```

### BL-05 — Messages enable rating (Credo integration)

```
Register two new users, approve both, do NOT send messages.
POST /rate → expect no_chat.
Send one message.
POST /rate → expect ok:true.
Verify: had_conversation(user1, user2) RPC returns true.
```

### BL-06 — Logout invalidates token

```
Login → get token.
POST /logout with token.
Retry any protected call with same token.
Expected: 401 unauthorized (session row deleted from sessions table).
```

### BL-07 — OTP expiry (5 minutes)

```
Register with phone.
Wait > 5 minutes (or update otp_codes.expiresAt to past in test DB).
POST /verify-phone with correct code.
Expected: otp_not_found_or_expired.
```

---

## Manual Testing Checklist

Use this list for exploratory / smoke testing in the browser after deployment.

### Registration flow
- [ ] Open `index.html` → registration form visible
- [ ] Submit with all fields → pending screen shown
- [ ] Error: empty nickname → alert with Russian message
- [ ] Error: duplicate nickname → alert "Этот никнейм уже занят"
- [ ] Error: duplicate phone → alert "Этот номер уже зарегистрирован"
- [ ] With phone: OTP screen shown after registration
- [ ] OTP hint visible in dev mode (`[DEV] Код: xxxxxx`)
- [ ] Enter `000000` → phone verified → continue
- [ ] Enter wrong code → error shows with attempts remaining
- [ ] After 5 wrong codes → "Слишком много попыток"
- [ ] "Отправить снова" link → new code displayed in dev mode

### Login / password flow
- [ ] Approved user (after set-password) → login succeeds → main screen
- [ ] Pending user → "Аккаунт ещё не одобрен" error
- [ ] Rejected user → "Аккаунт отклонён" error
- [ ] Wrong password → "Неверный никнейм или пароль"
- [ ] After login: demo bar shows current user
- [ ] Demo logout button → clears session → login screen shown
- [ ] Page refresh with valid token → auto-login (sync from server)

### Approval flow
- [ ] Approved user sees pending users in Users tab
- [ ] Click "Одобрить" → user moves to members list
- [ ] Click "Отклонить" → user disappears from pending list
- [ ] Newly approved user can log in

### Chat flow
- [ ] Open chat with approved partner → messages load
- [ ] Send message → appears immediately (localStorage)
- [ ] Refresh → message still there (synced from server)
- [ ] Unread badge / counter updates

### Credo rating flow
- [ ] "Есть оценки" notification appears after conversation
- [ ] Rate screen shows users you've chatted with
- [ ] Select stars and submit → cred updates on profile
- [ ] Rate the same user within 24h → error or silently ignored (client-side pre-check)
- [ ] Profile tab shows rating history with delta

### Security checks (manual)
- [ ] Open browser DevTools → `localStorage` — `fcom_token` present after login
- [ ] No `service_role` key visible anywhere in page source
- [ ] No `passwordHash` visible in any API response
- [ ] No `phone` visible in any API response (PostgREST or Edge Function)
- [ ] Logout → `fcom_token` and `fcom_reg_token` removed from localStorage

---

## Critical Security Scenarios

These must pass before production deployment.

### CSec-01 — Service role key not exposed

```
1. View page source and all JS files in the browser.
2. Search for "service_role" or the actual key value.
Expected: not found anywhere in frontend code.
```

### CSec-02 — `passwordHash` never in API responses

```
1. Login as alice. Intercept all network requests in DevTools.
2. Look for "passwordHash" in any response body.
Expected: not found. Edge Functions never SELECT passwordHash to return.
```

### CSec-03 — JWT token revocation works

```
1. Login → get token.
2. Immediately call POST /logout.
3. Try GET /users with old token.
Expected: 401. The jti is deleted from sessions table.
```

### CSec-04 — Trigger blocks direct cred modification

```
Run in Supabase SQL Editor (not as service_role — use Dashboard "SQL Editor" which runs as postgres):
  UPDATE public.users SET cred = 9999 WHERE nickname = 'alice';
Expected: ERROR: Direct update of users.cred is forbidden.
Note: if running as service_role, set app.allow_direct_write manually to test bypass:
  SELECT set_config('app.allow_direct_write', 'false', true);
  UPDATE public.users SET cred = 9999 WHERE nickname = 'alice';
→ should raise the exception.
```

### CSec-05 — OTP brute force protection

```
1. Register with a phone number.
2. Call POST /verify-phone with wrong code 5 times.
3. Call POST /verify-phone with the correct code.
Expected: the 5th wrong attempt returns too_many_attempts; the OTP is marked used.
The correct code also returns otp_not_found_or_expired (OTP is already invalidated).
```

### CSec-06 — Cross-user message isolation

```
1. Login as alice.
2. Call GET /messages?partnerId=frank.id (different school, no conversation).
Expected: { ok:true, messages:[] } — empty (RLS filters by participant).
Never returns bob↔carol messages.
```

### CSec-07 — fromUserId cannot be spoofed

```
1. Login as alice. Get alice's token.
2. POST /rate with body: { fromUserId: bob.id, toUserId: carol.id, score: 5 }
Expected: { ok:false, error:"fromUserId_mismatch" } — alice's token ≠ bob's id.
```

### CSec-08 — `phone` and `phoneVerified` not in column grants

```
1. Get Supabase anon key.
2. Fetch: GET <SUPABASE_URL>/rest/v1/users?select=phone,phoneVerified
   with header: apikey: <anon_key>
Expected: empty column set or error — these columns are not in the column-level GRANT.
```

---

## DB-Level Verification Queries

Run in Supabase SQL Editor after tests to confirm DB state.

```sql
-- Confirm trigger exists and is enabled
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'trg_guard_cred_and_status';

-- Confirm OTP brute-force counter works
SELECT phone, attempts, used, "expiresAt" FROM public.otp_codes ORDER BY "expiresAt" DESC LIMIT 5;

-- Confirm sessions are created on login and deleted on logout
SELECT "userId", jti, "expiresAt" FROM public.sessions ORDER BY "expiresAt" DESC LIMIT 10;

-- Confirm approval_log captures the correct actor
SELECT al."actorId", al."targetId", al.action, u_actor.nickname AS actor, u_target.nickname AS target
FROM public.approval_log al
JOIN public.users u_actor ON al."actorId" = u_actor.id
JOIN public.users u_target ON al."targetId" = u_target.id
ORDER BY al."createdAt" DESC LIMIT 10;

-- Confirm rate_log daily limit enforcement
SELECT "to", SUM(ABS("effectiveDelta")) AS daily_total
FROM public.rate_log
WHERE date > now() - INTERVAL '24 hours'
GROUP BY "to";

-- Confirm messages are stored correctly
SELECT "fromId", "toId", left(text, 30) AS preview, "createdAt", "readAt"
FROM public.messages ORDER BY "createdAt" DESC LIMIT 10;

-- Confirm device_blocks table
SELECT fingerprint, "createdAt" FROM public.device_blocks;

-- Confirm column-level grants (should NOT include passwordHash, phone, phoneVerified)
SELECT grantee, column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_name = 'users' AND table_schema = 'public'
ORDER BY grantee, column_name;
```
