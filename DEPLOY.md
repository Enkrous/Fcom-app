# Fcom — Deployment Guide

Full step-by-step guide for deploying the Fcom / Кредо backend to Supabase.

---

## Repository Structure

```
fcom/
├── index.html                  # Single-page frontend
├── style.css
├── credo.js                    # localStorage engine (never modified)
├── api.js                      # Backend bridge (monkey-patches Credo, JWT storage)
├── app.js                      # UI logic (never directly touches backend)
│
├── .env.example                # ← copy to .env.local, fill in secrets
│
├── migrations/                 # Numbered SQL files — applied in order
│   ├── 001_create_users.sql
│   ├── 002_create_otp_codes.sql
│   ├── 003_create_sessions.sql
│   ├── 004_create_messages.sql
│   ├── 005_create_rate_log.sql
│   ├── 006_create_device_blocks.sql
│   ├── 007_rls_policies.sql
│   ├── 008_functions_triggers.sql
│   ├── 009_pg_cron_cleanup.sql
│   ├── 010_rate_limit_log.sql
│   ├── 011_users_missing_constraints.sql
│   ├── 012_rate_log_db_constraints.sql
│   ├── 013_approval_log.sql
│   ├── 014_messages_read_status.sql
│   ├── 015_otp_attempts_counter.sql
│   ├── 016_approve_reject_rpc.sql
│   ├── 017_rate_atomic_rpc.sql
│   ├── 018_messages_unread_rpc.sql
│   └── 019_security_hardening.sql
│
└── supabase/
    ├── config.toml             # Local dev config (supabase start / supabase serve)
    ├── seed.sql                # Dev/staging test data (never run in production)
    └── functions/
        ├── _shared/            # Shared helpers imported by all functions
        │   ├── db.ts           # Supabase client (service_role)
        │   ├── jwt.ts          # Custom JWT sign / verify
        │   ├── bcrypt.ts       # PBKDF2-SHA256 password hashing
        │   ├── ratelimit.ts    # DB-backed rate limiting
        │   └── response.ts     # Uniform JSON response helpers
        ├── register/index.ts
        ├── verify-phone/index.ts
        ├── resend-otp/index.ts
        ├── login/index.ts
        ├── logout/index.ts
        ├── set-password/index.ts
        ├── approve/index.ts
        ├── reject/index.ts
        ├── rate/index.ts
        ├── messages/index.ts
        ├── users/index.ts
        └── cleanup/index.ts
```

---

## Migration Phases

The 19 migration files are organized into logical phases. Understanding these phases lets you deploy safely, troubleshoot failures, and add future migrations in the right place.

### Phase 1 — Core tables (001–006)

Creates all primary tables. No interdependencies within this phase.

| File | What it creates |
|---|---|
| `001_create_users.sql` | `users` table; unique index on `LOWER(nickname)`; school + status indexes |
| `002_create_otp_codes.sql` | `otp_codes` table; index on `phone` + expiry |
| `003_create_sessions.sql` | `sessions` table (JWT revocation); index on `jti` |
| `004_create_messages.sql` | `messages` table; indexes on `(fromId, toId)`, `createdAt` |
| `005_create_rate_log.sql` | `rate_log` table; indexes on `from`, `to`, `createdAt` |
| `006_create_device_blocks.sql` | `device_blocks` table; unique index on `fingerprint` |

### Phase 2 — Security layer (007)

Apply RLS immediately after tables exist. No policies = all rows accessible to anyone via PostgREST.

| File | What it creates |
|---|---|
| `007_rls_policies.sql` | RLS `ENABLE` + policies on all Phase 1 tables |

### Phase 3 — Business logic functions and triggers (008–009)

SQL stored procedures and scheduled jobs. Requires Phase 1 tables.

| File | What it creates |
|---|---|
| `008_functions_triggers.sql` | `apply_cred_delta`, `get_daily_cred_change`, `get_times_rated`, `had_conversation`, `auto_approve_first` trigger, `cleanup_*` functions |
| `009_pg_cron_cleanup.sql` | Enables `pg_cron`; schedules hourly `cleanup_expired_sessions` + `cleanup_expired_otp` |

### Phase 4 — Auxiliary tables (010–013)

Supporting tables that depend on Phase 1 tables (FK constraints).

| File | What it creates |
|---|---|
| `010_rate_limit_log.sql` | `rate_limit_log` table for persistent rate limiting |
| `011_users_missing_constraints.sql` | Unique indexes for `LOWER("fullName")` and `phone` on `users` |
| `012_rate_log_db_constraints.sql` | DB-level no-self-rate constraint; `enforce_rate_cooldown` trigger |
| `013_approval_log.sql` | `approval_log` table; `trg_log_status_change` trigger |

### Phase 5 — Feature enhancements (014–018)

Additive changes to existing tables and new RPCs.

| File | What it creates |
|---|---|
| `014_messages_read_status.sql` | `readAt` column on `messages`; `mark_messages_read()` RPC |
| `015_otp_attempts_counter.sql` | `attempts` column on `otp_codes` |
| `016_approve_reject_rpc.sql` | `approve_and_log()` + `reject_and_log()` atomic RPCs |
| `017_rate_atomic_rpc.sql` | `rate_and_apply()` atomic RPC |
| `018_messages_unread_rpc.sql` | `get_unread_counts()` + `conversation_summary()` RPCs |

### Phase 6 — Security hardening (019)

Must run **last** — it re-defines functions from phases 3 and 4 with the `app.allow_direct_write` guard, and adds the `trg_guard_cred_and_status` trigger. Running it before phases 3/4 would fail because the functions don't exist yet.

| File | What it creates |
|---|---|
| `019_security_hardening.sql` | Explicit `REVOKE` on all tables; column-level `SELECT` control; `users_safe` view; `guard_cred_and_status` trigger; patched versions of all write functions |

---

## Deployment Order

### Option A — Hosted Supabase (recommended for production)

#### 1. Create the project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Choose a region close to your users
3. Set a **strong database password** (save it; you'll need it for `supabase link`)
4. Wait for the project to be provisioned (~60 seconds)

#### 2. Set environment variables (Secrets)

Dashboard → **Settings** → **Edge Functions** → **Add new secret**

| Variable | Value |
|---|---|
| `JWT_SECRET` | At least 32-char random string — `openssl rand -hex 48` |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-available inside Edge Functions; no need to set manually |
| `SMS_API_URL` | Your SMS provider URL (leave blank for dev OTP mode) |
| `SMS_API_KEY` | Your SMS provider key (leave blank for dev OTP mode) |
| `ALLOWED_ORIGIN` | Your frontend domain, e.g. `https://fcom.example.com` |

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **automatically injected** by Supabase into every Edge Function. You do not need to add them as Secrets.

#### 3. Apply SQL migrations

Dashboard → **SQL Editor** → run each file in order:

```
001 → 002 → 003 → 004 → 005 → 006
→ 007
→ 008 → 009
→ 010 → 011 → 012 → 013
→ 014 → 015 → 016 → 017 → 018
→ 019   ← last, always
```

Paste each file's content and click **Run**. If a file fails, **stop** — fix the error before proceeding to the next file.

#### 4. Deploy Edge Functions

Install Supabase CLI if not already installed:

```bash
npm install -g supabase
```

Link to your project:

```bash
supabase login
supabase link --project-ref <your-project-ref>
# Project ref = the part before .supabase.co in your URL
```

Deploy all functions at once:

```bash
supabase functions deploy
```

Or deploy individually:

```bash
supabase functions deploy register
supabase functions deploy login
supabase functions deploy logout
supabase functions deploy verify-phone
supabase functions deploy resend-otp
supabase functions deploy set-password
supabase functions deploy approve
supabase functions deploy reject
supabase functions deploy rate
supabase functions deploy messages
supabase functions deploy users
supabase functions deploy cleanup
```

#### 5. Update frontend config

Open `api.js` and set your project URL:

```javascript
const SUPABASE_URL = 'https://your-project-ref.supabase.co';
```

#### 6. Run the launch checklist

See the **Launch Checklist** section below.

---

### Option B — Local Development

Requires [Docker Desktop](https://docker.com/products/docker-desktop) and the Supabase CLI.

```bash
# Start the local Supabase stack (Postgres + Edge Runtime + Studio)
supabase start

# Apply all migrations + seed data in one command
supabase db reset

# Serve Edge Functions locally with dev secrets
supabase functions serve --env-file .env.local

# Open local Studio
open http://localhost:54323
```

Set `SUPABASE_URL` in `api.js` to the local URL printed by `supabase start`:

```javascript
const SUPABASE_URL = 'http://localhost:54321';
```

To stop:

```bash
supabase stop
```

---

## Dev / Staging / Production Environments

### Recommended setup

| Environment | Supabase project | `JWT_SECRET` | SMS | Seed data | Notes |
|---|---|---|---|---|---|
| **local** | `supabase start` | `dev_only_secret_…` | blank (dev OTP) | `seed.sql` auto-applied on reset | Docker required |
| **staging** | Separate project | Unique secret | blank or test SMS | Run `seed.sql` manually once | Mirror of prod |
| **production** | Separate project | Unique secret (≥48 chars) | Real SMS provider | Never run seed | Live users |

**Critical rules:**
- Use a **different** Supabase project for each environment — never point staging at the production database
- Use a **different** `JWT_SECRET` per environment — tokens from dev must not validate in prod
- Never run `seed.sql` in production — it truncates all user data

### Environment variable matrix

| Variable | local | staging | production |
|---|---|---|---|
| `SUPABASE_URL` | `http://localhost:54321` | `https://staging-ref.supabase.co` | `https://prod-ref.supabase.co` |
| `JWT_SECRET` | 32-char dev secret | 48-char random | 64-char random (rotate yearly) |
| `SMS_API_URL` | `` (empty) | `` or test endpoint | real endpoint |
| `ALLOWED_ORIGIN` | `*` | `https://staging.fcom.example.com` | `https://fcom.example.com` |

---

## Key Security — Handling Secrets

### anon key

- Safe to embed in frontend HTML/JS
- Can only read data where RLS policies allow it
- In this project: `authenticated` and `anon` roles have **no INSERT/UPDATE/DELETE** on any table (revoked in `019_security_hardening.sql`)
- **Risk if leaked**: none beyond what RLS already exposes (no writes possible)

### service_role key

- Bypasses all RLS — treats every query as superuser
- Used **only inside Edge Functions** via `getServiceClient()` in `_shared/db.ts`
- **Never** put this in frontend code, `api.js`, or any client-side file
- **Never** commit it to git
- **If leaked**: rotate immediately in Dashboard → Settings → API → Reset service_role key; then redeploy all Edge Functions

### JWT_SECRET

- Signs and verifies all custom session tokens
- If changed, **all existing sessions are immediately invalidated** (users must re-login)
- Minimum 32 chars; 48+ recommended for production
- **If leaked**: change it immediately in Dashboard → Edge Functions → Secrets; all active sessions become invalid (acceptable security tradeoff)
- Store in a password manager; do not email or paste in chat

### Database password

- Used for direct Postgres connections and `supabase link`
- Not used by Edge Functions (they use the service_role key)
- Store in a password manager

---

## Launch Checklist

Run through this checklist before going live with any environment.

### Database

- [ ] All 19 migrations applied without errors, in order 001 → 019
- [ ] `SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public'` returns **11 tables**
  - `users`, `otp_codes`, `sessions`, `messages`, `rate_log`, `device_blocks`, `rate_limit_log`, `approval_log`, `users_safe` (view), ... plus cron internal tables
- [ ] `SELECT COUNT(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace` returns at least **12 functions**
- [ ] RLS is enabled on all 8 tables: `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false` should return **0 rows**
- [ ] `trg_guard_cred_and_status` trigger exists: `SELECT * FROM pg_trigger WHERE tgname = 'trg_guard_cred_and_status'`
- [ ] pg_cron jobs scheduled: `SELECT jobname FROM cron.job` shows `cleanup-expired-sessions` and `cleanup-expired-otp`

### Edge Functions

- [ ] All 12 functions deployed: `supabase functions list` shows all names
- [ ] `POST /register` returns `{ ok: true }` with a test body
- [ ] `POST /login` returns `{ ok: false, error: "invalid_credentials" }` for wrong password
- [ ] `POST /login` returns `{ ok: true, token: "..." }` for correct credentials
- [ ] Protected endpoint (`GET /users`) returns `{ ok: false, error: "unauthorized" }` without a token
- [ ] Protected endpoint returns correct data with a valid token

### Environment Variables

- [ ] `JWT_SECRET` is set and is at least 32 characters
- [ ] `JWT_SECRET` is different from any other environment
- [ ] `SMS_API_URL` / `SMS_API_KEY` set if real SMS is needed; blank otherwise
- [ ] `ALLOWED_ORIGIN` set to the frontend domain (not `*`) in production

### Security

- [ ] Confirm `service_role` key is NOT present in `api.js`, `index.html`, or any frontend file
- [ ] Confirm `JWT_SECRET` is NOT in any committed file (`.env.example` only has a placeholder)
- [ ] `supabase/seed.sql` has NOT been run in production
- [ ] `ALLOWED_ORIGIN` is not `*` in production

### Frontend

- [ ] `SUPABASE_URL` in `api.js` points to the correct project
- [ ] Local mode (`SUPABASE_URL = ''`) is NOT active in production build
- [ ] Dev OTP hints (`_devOtp`) are not visible in the UI when `SMS_API_URL` is configured

---

## Common Deployment Errors

### Migration errors

| Error | Cause | Fix |
|---|---|---|
| `relation "users" does not exist` | Applied a later migration before 001 | Run in strict order 001 → 019 |
| `function apply_cred_delta does not exist` | 019 ran before 008 | Run 008 first; re-run 019 |
| `duplicate key value violates unique constraint` | Re-running a migration that already applied | Use `IF NOT EXISTS` / `CREATE OR REPLACE` — all migrations are idempotent |
| `permission denied for schema cron` | pg_cron extension not yet enabled | Run `CREATE EXTENSION IF NOT EXISTS pg_cron;` then re-run 009 |
| `column "attempts" of relation "otp_codes" does not exist` | 015 not applied | Run 015; then re-run 016–019 if needed |

### Edge Function errors

| Error / Symptom | Cause | Fix |
|---|---|---|
| `Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY` (500) | Env vars not injected | On hosted: these are auto-injected. On local: run `supabase functions serve` |
| `JWT_SECRET env var is not set` (500) | Secret not configured | Dashboard → Settings → Edge Functions → add `JWT_SECRET` |
| `Function not found` (404) | Function not deployed | `supabase functions deploy <name>` |
| `unauthorized` on every request | Wrong `SUPABASE_URL` in `api.js` | Verify URL matches the Dashboard project URL |
| CORS error in browser | `ALLOWED_ORIGIN` mismatch | Set `ALLOWED_ORIGIN` to match the exact origin the browser sends |
| OTP always fails in dev | `SMS_API_URL` set to a dead endpoint | Clear `SMS_API_URL` to enable dev OTP mode |
| `Direct update of users.cred is forbidden` | Code directly `UPDATE users SET cred` | Use `apply_cred_delta()` RPC only; never direct UPDATE |
| `Direct update of users.status is forbidden` | Code directly `UPDATE users SET status` | Use `approve_and_log()` / `reject_and_log()` RPCs only |

### Frontend / API integration errors

| Symptom | Cause | Fix |
|---|---|---|
| `network_error` on every call | Wrong `SUPABASE_URL` in `api.js` | Double-check project URL |
| Login succeeds but app shows nothing | `_syncFromServer` failed silently | Open DevTools → Network; check `/users` and `/messages` responses |
| `account_not_approved` on login | User's `status` is still `pending` | Approve via another approved user in the app |
| `phone_not_verified` on login | `phoneVerified = false` | Complete OTP flow, or set directly: `UPDATE users SET "phoneVerified" = true WHERE nickname = '...'` (bypasses trigger safely — not a guarded field) |
| Ratings not saving | User has no prior conversation | Exchange at least one message before rating |
| JWT expires unexpectedly | System clock skew > 5 min | Ensure server and client clocks are synchronized |

---

## Useful SQL Diagnostic Queries

```sql
-- Check all tables and their RLS status
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- List all functions in the public schema
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
ORDER BY routine_name;

-- List all triggers
SELECT trigger_name, event_object_table, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;

-- Check cron jobs
SELECT jobname, schedule, active
FROM cron.job;

-- Check active sessions
SELECT id, "userId", "createdAt", "expiresAt"
FROM public.sessions
WHERE "expiresAt" > now()
ORDER BY "createdAt" DESC;

-- See current users and their status/cred
SELECT nickname, status, cred, "phoneVerified", "createdAt"
FROM public.users
ORDER BY "createdAt";

-- Verify guard trigger is in place
SELECT tgname, tgenabled, tgtype
FROM pg_trigger
WHERE tgname = 'trg_guard_cred_and_status';

-- Test apply_cred_delta directly (safe — uses the sanctioned function)
SELECT public.apply_cred_delta('<user-uuid>', 5);

-- Count unread messages per user
SELECT public.get_unread_counts('<user-uuid>');
```

---

## Adding a New Migration

When you need to change the schema in the future:

1. Create `migrations/020_<description>.sql`
2. Use `IF NOT EXISTS` / `CREATE OR REPLACE` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` so it's safe to re-run
3. Test locally: `supabase db reset` (applies all migrations + seed)
4. Apply to staging first; verify; then apply to production
5. Update `BACKEND.md` → "Run migrations" section to include the new file

**Naming convention:** `NNN_verb_subject.sql`  
Examples: `020_add_school_settings.sql`, `021_notifications_table.sql`
