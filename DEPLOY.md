# Fcom Deployment

Fcom is a vanilla HTML/CSS/JS SPA plus Supabase Postgres, Storage, and Edge Functions. It is not an iOS-native deployment.

## Source Layout

- `index.html`, `style.css`, `avatars.js`, `presence.js`, `notifications.js`, `credo.js`, `api.js`, `app.js` - browser SPA.
- `landing.html`, `assets/splash.json`, `vendor/lottie.min.js` - static landing and self-hosted splash animation assets.
- `supabase/functions` - Edge Functions and shared Deno helpers.
- `supabase/migrations` - current Supabase CLI migration stream.
- `migrations` - legacy/manual numbered SQL stream. Keep separate unless a migration strategy says otherwise.
- `tests/postman` - Postman collection/environment for existing backend checks.
- `tests/sql/group_table_security_checks.sql` - group and safety table grants/RLS regression check.

## Production Warning

Do not run `supabase/seed.sql` in production. It truncates/deletes application tables and inserts fixed test users with known passwords. Use it only for local development or disposable staging data.

## Configure Supabase

Required Edge Function secrets:

- `JWT_SECRET` - random secret, at least 32 characters.
- `CLEANUP_SECRET` - secret for the cleanup endpoint if used.

Optional secrets:

- `SMS_API_URL`
- `SMS_API_KEY`
- `ALLOWED_ORIGIN`

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Keep the service role key server-side only. Browser files must use only public configuration.

## Apply Migrations

`supabase db push` applies files from `supabase/migrations`.

Current files in `supabase/migrations`:

- `20260422000000_020_add_avatarurl_to_users.sql`
- `20260422000001_021_avatars_storage_rls.sql`
- `20260517120000_022_admin_role.sql`
- `20260517120001_023_disable_auto_approve.sql`
- `20260517153000_024_groups_and_media.sql`
- `20260517170000_025_canonicalize_fiztekh_school.sql`
- `20260826120000_027_harden_group_table_access.sql`
- `20260827120000_028_user_safety_reports_blocks.sql`

Do not deploy or repair `20260523120000_026_unify_all_users_into_fiztex.sql` unless the project explicitly decides to merge all production users into `Fiztex`. It is a data migration, not part of the current safe deployment path.

Important: the active Supabase folder currently starts at `020`. The plain `migrations/001_create_users.sql` through `021_disable_auto_approve.sql` folder is a separate legacy/manual SQL set. For a brand-new database, verify that the base schema already exists or explicitly decide how to apply/port the base migrations before relying on `supabase/migrations` alone.

## Deploy Functions

Deploy all current Edge Functions:

```bash
supabase functions deploy admin-stats
supabase functions deploy approve
supabase functions deploy block-user
supabase functions deploy cleanup
supabase functions deploy groups
supabase functions deploy login
supabase functions deploy logout
supabase functions deploy me
supabase functions deploy messages
supabase functions deploy rate
supabase functions deploy register
supabase functions deploy reject
supabase functions deploy report-user
supabase functions deploy reports-admin
supabase functions deploy resend-otp
supabase functions deploy set-password
supabase functions deploy upload-media
supabase functions deploy users
supabase functions deploy verify-phone
```

## Frontend Configuration

Set `SUPABASE_URL` in `api.js` for the target Supabase project. Leave it empty only for localStorage-only demo mode.

The frontend is localStorage-first:

- `credo.js` remains the local data engine.
- `api.js` calls Edge Functions and mirrors backend responses into localStorage.
- Group, invite, media, safety, admin, auth, approval, messaging, and rating writes should go through Edge Functions, not direct PostgREST writes from the browser.

## Security Model To Verify

- No `service_role` key in frontend files.
- `auto_approve_first()` is a no-op; new users remain `pending`.
- `users.role` exists and is constrained to `member` or `admin`.
- Admin-only flows check `role = 'admin'` and `status = 'approved'`.
- `chat_groups`, `group_members`, and `group_invites` have RLS enabled.
- `user_reports` and `user_blocks` have RLS enabled.
- `anon` and `authenticated` do not have direct `SELECT`, `INSERT`, `UPDATE`, or `DELETE` on group/safety tables.
- Edge Functions keep using `service_role` for group/member/invite/report/block writes.

Run the group/safety-table SQL regression check after migrations:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/group_table_security_checks.sql
```

The same SQL can also be run in the Supabase SQL Editor.

## Smoke Checks

After deployment:

- Register a new user and confirm the user is `pending`, not auto-approved.
- Log in as an approved admin and open the Admin tab.
- Call `GET /functions/v1/admin-stats` as admin.
- Create a private group through the UI or `/groups`.
- Invite a member, then accept and decline invites through `/groups`.
- Load school-public and private groups through `/groups`.
- Send direct and group messages through `/messages`.
- Upload an image through `/upload-media`, then send it through `/messages`.
- Report a user through `/report-user`, then close the report through `/reports-admin` as admin.
- Block a user through `/block-user` and confirm direct `/messages` returns `user_blocked`; then unblock.

## Adding Future Migrations

Add new Supabase CLI migrations under:

```text
supabase/migrations/YYYYMMDDHHMMSS_description.sql
```

Do not add matching files to plain `migrations/` unless the project explicitly decides to keep that legacy/manual stream synchronized.
