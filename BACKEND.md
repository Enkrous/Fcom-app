# Fcom Backend Architecture

This repository is a vanilla HTML/CSS/JS single page app backed by Supabase. It is not an iOS-native project.

## Frontend Shape

- `index.html` contains the SPA markup, including onboarding, settings, the Admin tab, safety modals, group list/invites UI, chat composer, and image input.
- `style.css` contains the visual styling.
- `credo.js` is still the localStorage-first domain engine.
- `api.js` is the Supabase bridge. When `SUPABASE_URL` is empty, the app falls back to localStorage behavior. When Supabase is configured, writes go through Edge Functions and responses are synced back into localStorage.
- `app.js` owns UI state and rendering. It uses groups, invites, media, safety, and admin data through `Credo`/`API`, not by directly calling PostgREST tables.

Script load order in `index.html` is:

```html
avatars.js
presence.js
notifications.js
credo.js
api.js
app.js
```

## Auth And Roles

The app uses custom HS256 JWTs issued by Edge Functions, plus the `sessions` table for revocation. Browser code must not contain the Supabase `service_role` key.

Users have:

- `status`: `pending`, `approved`, or `rejected`
- `role`: `member` or `admin`

`auto_approve_first()` is now a legacy no-op. New users stay `pending` until an admin approves them. The first user in a school is no longer auto-approved.

Admins are users with `role = 'admin'`. The frontend has an Admin tab, and backend aggregate data is served by the `admin-stats` Edge Function.

## Edge Functions

Current functions under `supabase/functions`:

- `admin-stats` - GET admin dashboard stats; requires approved admin.
- `approve` - POST approve a pending user; admin gated.
- `block-user` - GET/POST current user's block list; writes via service_role.
- `cleanup` - POST cleanup endpoint.
- `groups` - GET group list/invites; POST create private group, respond to invite, or leave private group.
- `login` - POST login and session creation.
- `logout` - POST revoke current session.
- `me` - GET current user and approval capability.
- `messages` - GET/POST direct and group messages, including image attachment metadata.
- `rate` - POST credo rating.
- `register` - POST registration; creates pending member and syncs school-public group membership.
- `reject` - POST reject a pending user; admin gated.
- `report-user` - POST user safety report against an approved same-school target.
- `reports-admin` - GET/POST admin report review flow.
- `resend-otp` - POST resend phone OTP.
- `set-password` - POST set or reset password for the current token.
- `upload-media` - POST image upload to private `chat-media` storage bucket.
- `users` - GET approved users; pending users are included for admins.
- `verify-phone` - POST phone OTP verification.

Shared helpers live in `supabase/functions/_shared`:

- `db.ts` creates the Supabase client with `SUPABASE_SERVICE_ROLE_KEY`.
- `jwt.ts` signs/verifies custom JWTs and checks session revocation.
- `bcrypt.ts` implements PBKDF2-SHA256 password hashing.
- `ratelimit.ts` stores rate-limit state in Postgres.
- `response.ts` provides common JSON/CORS responses.
- `groups.ts` contains school-public group and group access helpers.
- `blocks.ts` contains pairwise user block checks shared by users/messages/rate/groups.
- `school.ts` normalizes/canonicalizes school names.

## Groups And Media

The group/media subsystem was added in Supabase migration `20260517153000_024_groups_and_media.sql`.

Tables:

- `chat_groups`: private groups and one `school_public` group per school.
- `group_members`: active memberships with `role` values `admin` or `member`.
- `group_invites`: invite flow for private groups with `pending`, `accepted`, or `declined` status.

Messages support either a direct `toId` target or a `groupId` target. Image media is uploaded through `upload-media` into the private `chat-media` bucket, then referenced from `messages` via attachment columns.

Frontend group operations use `API.createGroup`, `API.respondGroupInvite`, `API.leaveGroup`, `API.sendMessage`, and `API.uploadMedia`. The backend writes are performed by `groups`, `messages`, and `upload-media` Edge Functions through `service_role`.

## Safety Reports And Blocks

Migration `20260827120000_028_user_safety_reports_blocks.sql` adds:

- `user_reports`: reports from an approved same-school user about another approved same-school user.
- `user_blocks`: pairwise direct-contact blocks.

Frontend safety operations use `API.reportUser`, `API.blockUser`, `API.unblockUser`, `API.listReports`, and `API.reviewReport`. Browser code does not write `user_reports` or `user_blocks` directly. Direct messages, rating, group invite creation, and invite acceptance check pairwise blocks through shared Edge Function helpers.

## RLS And Grants

The architecture keeps browser writes out of PostgREST. Edge Functions are the main write path and use `service_role`.

For `chat_groups`, `group_members`, and `group_invites`, migration `20260826120000_027_harden_group_table_access.sql` sets the current security model. For `user_reports` and `user_blocks`, migration `20260827120000_028_user_safety_reports_blocks.sql` uses the same model:

- RLS is enabled on these tables.
- All table privileges are revoked from `PUBLIC`, `anon`, and `authenticated`.
- Direct `SELECT`, `INSERT`, `UPDATE`, and `DELETE` by `anon`/`authenticated` are not allowed.
- `service_role` has explicit `SELECT`, `INSERT`, `UPDATE`, and `DELETE` grants.
- RLS policies are service-role-only `FOR ALL` policies.

This is compatible with the current Edge Function architecture because Supabase `service_role` bypasses RLS, while the policies and grants document/enforce the intended access path.

## Migrations

`supabase/migrations` is the active Supabase CLI migration folder in this repo:

- `20260422000000_020_add_avatarurl_to_users.sql`
- `20260422000001_021_avatars_storage_rls.sql`
- `20260517120000_022_admin_role.sql`
- `20260517120001_023_disable_auto_approve.sql`
- `20260517153000_024_groups_and_media.sql`
- `20260517170000_025_canonicalize_fiztekh_school.sql`
- `20260826120000_027_harden_group_table_access.sql`
- `20260827120000_028_user_safety_reports_blocks.sql`

`20260523120000_026_unify_all_users_into_fiztex.sql` may exist in a local worktree as a data-migration draft. Do not include it in production pushes unless the project explicitly decides to merge all schools into `Fiztex`.

The plain `migrations/` folder also exists with legacy/manual numbered files `001_create_users.sql` through `021_disable_auto_approve.sql`. It is not identical to `supabase/migrations`, and it is not automatically used by `supabase db push`. Do not edit or apply the plain folder as if it were the current Supabase CLI stream unless that migration strategy is decided separately.

## Tests

Test assets currently present:

- `tests/postman/fcom.postman_collection.json`
- `tests/postman/fcom.postman_environment.json`
- `tests/sql/group_table_security_checks.sql`

The SQL regression check verifies RLS/grants for `chat_groups`, `group_members`, `group_invites`, `user_reports`, and `user_blocks`.

## Seed Data Warning

`supabase/seed.sql` is for local development or disposable staging data only. It truncates/deletes tables and inserts fixed test accounts/passwords. Never run it in production.
