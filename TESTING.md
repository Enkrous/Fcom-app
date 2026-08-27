# Fcom Testing

These checks describe the current repository shape: vanilla HTML/CSS/JS SPA plus Supabase Edge Functions. They are not iOS tests.

## Test Assets

- `tests/postman/fcom.postman_collection.json`
- `tests/postman/fcom.postman_environment.json`
- `tests/sql/group_table_security_checks.sql`

The Postman collection is a manual/portable regression suite for the current backend paths: auth setup, registration, OTP, password setup, login/logout, pending approval, approve/reject, direct messages, rating, groups, invites, media upload, safety reports/blocks, admin stats, and security smoke checks.

## Test Environment

- Apply the required schema migrations for the target database.
- Deploy Edge Functions from `supabase/functions`.
- Set `JWT_SECRET`.
- Leave `SMS_API_URL` empty for dev OTP mode.
- Use `supabase/seed.sql` only in local/dev or disposable staging.
- Import the Postman environment or set equivalent variables manually.
- Set `supabase_url` and `supabase_anon_key` before running direct PostgREST security tests.
- Use an approved admin token for admin-only folders. Auth Setup captures `admin_token` from `alice` only when `alice.role === 'admin'`; otherwise set `admin_token` manually.
- For media upload, choose a small local image file in Postman for `MU-01` or set `media_file_path`.

Never run `supabase/seed.sql` in production. It truncates/deletes data and inserts fixed test accounts with known passwords.

## Current Behavior To Assert

- Registration creates `status = 'pending'`.
- The first user in a school is not auto-approved.
- `auto_approve_first()` exists only as a legacy no-op.
- `users.role` exists and uses `member` or `admin`.
- Admin-only endpoints require `role = 'admin'` and `status = 'approved'`.
- Browser writes go through Edge Functions, not direct PostgREST table writes.
- `credo.js` remains localStorage-first.
- Reports and user blocks are written through `report-user`, `block-user`, and `reports-admin`.
- Onboarding/settings are static SPA flows backed by localStorage.

## Postman Manual Run

Use the deployed function base URL, for example:

```text
https://<project-ref>.functions.supabase.co
```

Run folders in order:

- `0. Auth Setup` logs in seed users and captures `alice_token`, `bob_token`, `carol_token`; it also captures `admin_token` when `alice` is an admin.
- `1. Registration` covers pending registration, phone/dev OTP registration, validation errors, and a pending reject target.
- `2. OTP Verification` covers `/verify-phone` and `/resend-otp` in dev OTP mode.
- `3. Set Password` covers registration-token password setup and auth failures.
- `4. Login / Logout` covers approved login, pending/rejected login blocks, temporary logout, and revoked-token rejection.
- `5. Approve / Reject` covers admin approval, pending queue visibility, non-admin denial, missing target, and reject with device fingerprint.
- `6. Messages` covers direct message send/read, empty text, no JWT, and cross-school denial.
- `7. Credo Rating` covers rating after conversation, self-rate, invalid scores, sender spoofing, cross-school/no-chat behavior, and no JWT.
- `8. Groups` covers school-public group listing, private group creation, invite accept/decline, private visibility, group messages, no JWT, and unsupported actions.
- `9. Media Upload` covers image upload through `/upload-media`, image message metadata through `/messages`, signed attachment URLs, no JWT, and missing file.
- `10. Safety Reports / Blocks` covers `/report-user`, `/block-user`, `/reports-admin`, non-admin denial, and blocked-message denial.
- `11. Admin Stats` covers `/me` admin precondition, `/admin-stats`, member denial, and no JWT.
- `12. Group and Safety Table Security` covers direct PostgREST negative checks for `chat_groups`, `group_members`, `group_invites`, `user_reports`, and `user_blocks`.
- `13. Security` covers general auth failures, logout token revocation, and sensitive-field omissions.

## Edge Function Smoke Checks

- `POST /register` returns `{ ok: true, user: { status: "pending", role: "member" }, token }`.
- `POST /verify-phone` verifies a phone/dev OTP code.
- `POST /set-password` works with the registration token.
- `POST /login` succeeds only for approved users; `/logout` revokes the current session token.
- `POST /approve` and `POST /reject` require an approved admin.
- `GET /me` returns the current user and approval capability.
- `GET /users` returns approved users; pending users are included for admins.
- `POST /rate` requires an approved caller, valid score, same school, and an existing conversation.
- `POST /messages` supports direct messages and group messages, with optional image attachment metadata.
- `GET /messages` reads either `partnerId` or `groupId` conversations.
- `GET /groups` returns available groups, embedded members, and pending invites.
- `POST /groups` with `action: "create"` creates a private group and pending invites.
- `POST /groups` with `action: "respond_invite"` accepts or declines an invite.
- `POST /groups` with `action: "leave"` leaves a private group.
- School-public groups are created/synced through backend helpers.
- Private groups are visible only to members, except admins can observe through the backend.
- `POST /upload-media` accepts images only and returns `{ ok: true, media }`.
- `POST /report-user` creates an open report for an approved same-school target.
- `GET /block-user` returns the current user's block list.
- `POST /block-user` with `action: "block"` or `"unblock"` updates peer blocks.
- Blocked direct messages and ratings return `{ ok: false, error: "user_blocked" }`.
- `GET /reports-admin` and `POST /reports-admin` work only for approved admins.
- `GET /admin-stats` works only for approved admins.

## Group And Safety Table Grants/RLS Regression

Run after applying migrations:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/group_table_security_checks.sql
```

Or paste `tests/sql/group_table_security_checks.sql` into the Supabase SQL Editor.

Expected result:

- RLS is enabled on `chat_groups`, `group_members`, `group_invites`, `user_reports`, and `user_blocks`.
- `anon` and `authenticated` do not have direct `SELECT`, `INSERT`, `UPDATE`, or `DELETE` on those tables.
- `service_role` has the grants needed by Edge Functions.
- The check fails if any expectation is false.

## PostgREST Negative Checks

The Postman folder `12. Group and Safety Table Security` directly calls:

- `/rest/v1/chat_groups`
- `/rest/v1/group_members`
- `/rest/v1/group_invites`
- `/rest/v1/user_reports`
- `/rest/v1/user_blocks`

Expected result:

- Direct `anon` and browser-authenticated `SELECT`, `INSERT`, `UPDATE`, and `DELETE` attempts fail with a non-2xx response.
- Successful group writes still happen through `/groups`, `/messages`, and `/upload-media` Edge Functions.
- Successful safety writes still happen through `/report-user`, `/block-user`, and `/reports-admin` Edge Functions.
- The SQL regression file remains the source of truth for catalog-level RLS/grant assertions.

## Manual Frontend Smoke Checks

- Landing loader: open `index.html`, confirm the landing iframe loads, the splash hides, and CTA still opens the app.
- Onboarding happy path: clear `fcom_onboarding_seen_v1`, click register from landing, step through all onboarding cards, and confirm registration appears.
- Onboarding negative path: click `Пропустить`; reload and confirm onboarding does not repeat.
- Settings happy path: log in as an approved user, open Profile -> Settings, toggle notifications, reload, and confirm the toggle persists.
- Report happy path: open another user's profile, submit a report, and confirm Admin tab shows it for an admin.
- Block happy path: block another user, confirm they disappear from direct member/chat lists and appear in Settings -> Blocked.
- Block negative path: try to send a direct message to a blocked user; expected UI/server error is `user_blocked`.

No CI is configured for these checks. Keep this as a manual/portable test plan unless the repo later adds a package/runtime test harness.
