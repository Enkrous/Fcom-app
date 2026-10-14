# Fcom Testing

The repository contains a vanilla HTML/CSS/JS web app, Supabase Edge Functions, SQL migrations, and an initial SwiftUI client. The backend wire format is documented in [docs/api-contract.md](docs/api-contract.md); deployment and migration history are documented in [DEPLOY.md](DEPLOY.md) and [docs/migration-history-2026-10-14.md](docs/migration-history-2026-10-14.md).

## Local automated checks

Run from the repository root with Node.js, pnpm, and Deno installed:

```powershell
pnpm install --frozen-lockfile
deno task check
pnpm run test:edge
pnpm run test:sql
pnpm run test:web
pnpm run test:guards
```

Equivalent commands after dependency installation:

```powershell
deno test --allow-env tests/credo_test.ts tests/edge
node tests/run-sql.mjs
node --test tests/web-safety-credo.test.mjs
node --test tests/postman_guard.test.mjs
```

- Edge tests cover Credo boundaries and eligibility, database failures, blocking/unblocking, request-scoped errors, media cleanup, push registration, and APNs payloads/transport with mocks. They do not confirm delivery to an Apple device.
- `tests/run-sql.mjs` creates a fresh PostgreSQL/PGlite database, applies both migration directories in order, and runs every `tests/sql/*.sql` suite. Application tables, grants, functions, triggers, and constraints are real SQL. Supabase Auth, Storage metadata, and cron platform facilities are stubbed; actual Storage uploads and concurrent database connections are not exercised by this harness.
- SQL suites cover account deletion and group/history preservation, ACL/RLS, image captions, the atomic report quota, device tokens, and media-upload finalization. Behavioral suites roll back their fixture transactions.
- Web tests cover the restored blocked-user settings flow and server-supplied Credo behavior. Guard tests execute the actual shipped Postman scripts, including combined collection/item scopes, absolute SDK URL construction, fixture allowlists, provenance checks, and refusal of foreign deletion targets. These tests make no HTTP requests and need no private credentials.

There is no configured CI workflow; run these commands before deployment. Building or running `ios/Fcom.xcodeproj` requires macOS and Xcode. Its build was not verified by these Windows checks.

## Hosted schema and access checks

After applying migrations, run the catalog checker against the target database using a privately supplied connection string:

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/group_table_security_checks.sql
```

Alternatively, paste that file into Supabase SQL Editor, or run the read-only verification script:

```powershell
node scripts/verify-production.mjs
```

The script accepts `DATABASE_URL`, or `SUPABASE_PROJECT_REF` plus `SUPABASE_DB_PASSWORD`. Supply credentials outside source control and do not paste them into test reports. The checker uses temporary result storage and fails on a false assertion; it does not seed or modify application rows.

The SQL checker is authoritative for `PUBLIC`, `anon`, and Supabase `authenticated` privileges, including all public application tables, column grants, views, sequences, service-only RPCs, and default ACL. RLS must be enabled and client roles must have no direct application-table access. The expected assertion count grows when schema objects are added; use the actual result rather than a fixed historical count.

The main Postman collection also sends negative PostgREST requests to group and safety tables. A Fcom custom JWT is not a Supabase Auth JWT: rejection by the gateway verifies that this custom token cannot access PostgREST, but does not independently prove `authenticated` database privileges. That proof comes from the SQL checker.

## Postman prerequisites

The portable assets are:

- `tests/postman/fcom.postman_collection.json`: the main 104-request regression suite.
- `tests/postman/fcom.api-contract-smoke.postman_collection.json`: 15 contract, session-revocation, stale-unblock, and self-service deletion checks.
- `tests/postman/fcom.postman_environment.json`: a local environment template with no live credentials.

Before an HTTP run, apply the complete required schema, deploy the Edge Functions, configure `JWT_SECRET`, and configure dev OTP mode without `SMS_API_URL` for the OTP fixtures. Upload tests require a small local image supplied through `media_file_path`. Set `base_url` to the Edge Functions root and `supabase_url`/`supabase_anon_key` for direct PostgREST checks. Edge Functions use Fcom bearer JWTs; the service-role key must never be placed in the collection.

For a new database, `supabase/migrations` alone is not a complete bootstrap: its historical stream starts at 020 and depends on the older base schema. Follow DEPLOY.md and reconcile migration history before using CLI reset/push commands.

The fixed `supabase/seed.sql` accounts are for local or disposable staging only. The seed truncates/deletes existing application data. It must never run in production. It also does not grant Alice the current `admin` role: in the disposable database, set the designated fixture Alice to `role='admin'`, `status='approved'` before running admin folders. Auth Setup captures `admin_token` only when that logged-in Alice is an admin. Do not substitute a real user's or App Review token.

The main suite expects seven fixture users: approved admin Alice, approved Bob and Carol in the same school, pending Dave, rejected Eve, approved Frank in a second school, and pending Grace in the second school. Alice/Bob and Alice/Carol must have direct conversations. Existing recent ratings, open reports, blocks, and limiter state can affect repeated runs; start from a fresh disposable fixture namespace when a full repeat needs clean state.

## Mandatory HTTP-run guards

Both collections enforce their collection-level pre-request guards. Keep these guards enabled in Postman and Newman.

| `test_environment` | Allowed target |
|---|---|
| `local` | Loopback hosts only, using the local fixture environment |
| `disposable-staging` | Explicitly disposable hosted staging over HTTPS |
| `isolated-production-fixtures` | HTTPS production with explicit permission and a generated fixture allowlist |

The known production project is refused in staging mode. Production requires all of the following:

- `allow_production_fixtures=true` and `test_environment=isolated-production-fixtures`.
- A fresh `fcom_fixture_prefix` matching `postman_` followed by 12 lowercase hexadecimal characters.
- `fixture_user_ids` as a JSON array of seven distinct generated UUIDs, excluding fixed seed IDs. Every `alice_id` through `grace_id` must belong to this allowlist and the corresponding nicknames must use the namespace prefix.
- All identity, registration, school, phone, fingerprint, and group-name variables must describe only that run's disposable fixtures. Override collection defaults in the private environment; they are local seed defaults, not production fixtures.
- Bearer JWT subjects, mutation targets, group/report IDs, invitation IDs, and direct PostgREST mutation filters must pass the guards' allowlist/provenance checks. IDs captured from registration must carry their generated namespace marker. Do not fabricate verification markers or bypass a failed guard.

The 15-request smoke collection creates and verifies its own new disposable account before `delete-account`. Deletion is refused for the primary fixtures and for an unverified/mismatched account token. Existing users and App Review accounts must never be used as deletion fixtures.

The production release run used a one-off private SQL setup and private environment files. There is no repository script that provisions the main seven-user QA fixture set. `scripts/provision-app-review.mjs` provisions a different, persistent review fixture and must not be used as a substitute. Arrange isolated fixture provisioning before a production regression run; the supplied environment template is not ready for production merely by changing its URL.

Keep private environments, JWT captures, passwords, fixture manifests, and raw Newman reports outside Git. Reports can include request bodies, authorization headers, and response tokens. Use a private directory outside the checkout, or the ignored `test-results/` directory for local reports. Share only redacted counts/findings. After a production run, remove only its verified disposable namespace, including generated registrations and their dependent data, then verify that original and App Review accounts remain intact.

## Running Postman / Newman

On local or disposable staging, import both JSON collections and the environment into Postman, fill in the variables above, and run the main folders in order. For a direct local command, after preparing the fixtures and private environment:

```powershell
node node_modules/newman/bin/newman.js run tests/postman/fcom.postman_collection.json -e ../private-postman/environment.json --delay-request 13000 --export-environment ../private-postman/main-state.json
node node_modules/newman/bin/newman.js run tests/postman/fcom.api-contract-smoke.postman_collection.json -e ../private-postman/main-state.json --delay-request 2000 --export-collection ../private-postman/smoke-state.json
```

The 13-second registration pacing avoids the real five-requests-per-IP-per-minute limiter; do not disable the production limiter for tests. OTP resend has its own cooldown. A full main run with this conservative delay takes time. To reduce delay elsewhere, run phases while exporting and reusing the environment after each phase:

```powershell
node node_modules/newman/bin/newman.js run tests/postman/fcom.postman_collection.json -e ../private-postman/environment.json --folder '0. Auth Setup — Login seed users' --export-environment ../private-postman/phase0.json
node node_modules/newman/bin/newman.js run tests/postman/fcom.postman_collection.json -e ../private-postman/phase0.json --folder '1. Registration' --delay-request 13000 --export-environment ../private-postman/phase1.json
```

Then run folders 2–13 together, preserving order and captures. In PowerShell, the following derives their exact names from the collection:

```powershell
$collectionPath = 'tests/postman/fcom.postman_collection.json'
$collection = Get-Content -LiteralPath $collectionPath -Raw | ConvertFrom-Json
$newmanArgs = @('run', $collectionPath, '-e', '../private-postman/phase1.json', '--delay-request', '2000', '--export-environment', '../private-postman/phase2.json')
foreach ($folder in $collection.item[2..13]) {
  $newmanArgs += @('--folder', $folder.name)
}
node node_modules/newman/bin/newman.js @newmanArgs
```

The main collection writes captures to the environment; reuse its latest exported file. **Do not rerun Auth Setup between later phases or targeted rechecks**: its first login clears previous registration/group/report captures to prevent stale reuse. Use the captured current-run environment when repeating a failed later request. Do not clear provenance fields to make a request pass. The smoke suite stores captures in collection variables and generates a fresh account on each run; its private exported collection retains the identity/token for scoped cleanup if a run stops early. Never commit either kind of captured state.

Main folder coverage includes registration/OTP/passwords; pending/rejected/approved login and logout; admin approval/rejection; direct and group messages; Credo fields and rating eligibility; group invites; image upload/signed URLs; reports and blocks; admin statistics; direct PostgREST denial; and session/privacy checks. The smoke suite adds server Credo DTO assertions, `usersToRate`/`canRate`, `senderDeleted`, idempotent stale-target unblock, and account-deletion/session-revocation checks.

## Recorded production verification, 14–15 October 2026

See [docs/backend-release-2026-10-14.md](docs/backend-release-2026-10-14.md) for deployment status and limits of verification.

- The main suite covered all 104 unique requests in phases, with 279 successful assertions across the successful checks and rechecks. The initial later phase had failures: M02 exposed a malformed SDK URL, which was fixed, and C00 returned one transient `fetch_failed` 500 with an undetermined cause. Both were successfully replayed. This was a phased run with corrections and repeats, not one uninterrupted clean run.
- The final separate contract smoke run was clean: 15 requests, 33 assertions, zero failures. A preceding attempt exposed an item/collection script-scope collision; the guards were isolated and a combined-scope regression test was added before the clean repeat.
- Additional isolated live checks confirmed separate report quotas for users sharing an IP and preservation of group messages and signed image access after the creator deletes their account. Temporary QA accounts/data were then removed without deleting the persistent review fixture.
- The new upload-finalization SQL tests verify both upload/deletion orderings, queued orphan cleanup, scoped paths, and service-only access. Local PGlite checks do not constitute a multi-connection stress test. The deployed upload function also passed an isolated live upload/delete/revocation/Storage-cleanup check; see the release report for details.
- APNs delivery awaits the Apple `.p8` credentials and a real device. Push hooks are implemented, but there is no durable APNs retry queue. Periodic protected `cleanup` calls are still required to retry queued orphan-media removal.

## Manual web checks

- Open the landing page, enter the app, complete or skip onboarding, and verify per-user completion after reload.
- Log in as an approved fixture. Check that profile/directory Credo levels, progress, and available rating targets use server data; test a fractional score near a level boundary.
- Block a fixture peer and open Settings → Blocked users. Unblock it and verify its return to direct-contact lists. Repeat with a stale rejected/moved target; unblock remains available. Blocked messaging/rating must fail with `user_blocked`.
- Send direct and group text/image messages. Verify signed image access, including an image with an empty caption. Ensure a deleted group author has `senderDeleted=true` and surviving participants retain history.
- Submit a report, verify it in the fixture admin account, and check member denial for admin screens.
- Delete only a dedicated disposable account from Settings. Verify local tokens/profile are cleared; the old session fails with `session_revoked`, and password login for the deleted account fails with `invalid_credentials`.

These checks describe the committed web source. They do not establish that its frontend hosting has been deployed, and the Settings notification toggle does not by itself prove browser or iOS push delivery.
