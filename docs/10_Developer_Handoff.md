# Fcom Messenger — Final Developer Handoff Package

**Status:** Planning phase complete. This document consolidates all prior analysis and proposals into one implementation-ready reference. No code has been written to the repository; no database changes have been executed; nothing has been deployed. This is a planning artifact for the lead developer's use.

**Session tooling note:** Figma MCP and Supabase MCP are not connected in the current tool session (only `cursor-app-control` and `cursor-ide-browser` are available). Every conclusion below that would normally cite Figma/Supabase MCP instead cites the underlying source (source code, migrations, or the earlier phases of this engagement where those MCPs *were* available) and is labeled accordingly in the Technical Decisions section. Nothing here was fabricated to fill an MCP gap.

---

# Executive Summary

**Overall project understanding:** Fcom Messenger is a production, vanilla HTML/CSS/JS single-page web application (no build tool, no framework, no bundler) backed entirely by Supabase (Postgres, Edge Functions in Deno, Storage). It is a school-scoped social messenger: users register with real name, school, and school-class ("Класс," e.g. "10А"), are approved by an existing approved peer or admin in the same school, then get access to 1:1 chat, group chat, photo attachments, and a peer-rating ("cred") system. Authentication is a custom HS256 JWT implementation, not Supabase Auth. The frontend follows a distinctive "localStorage-first, server-shadow" pattern: `credo.js` is a synchronous local state engine; `api.js` monkey-patches its write methods to shadow-sync to the backend and polls `/me` (and related endpoints) every 2 seconds to keep local state current.

**Architecture summary:** Single-module frontend (`app.js` for UI/routing, `credo.js` for local state, `api.js` for backend sync, `credo-effects.js`/`notifications.js`/`presence.js` for supporting concerns), CSS-variable-based design system (`style.css`), 11 existing Postgres tables, all business logic enforced through Deno Edge Functions using the Supabase `service_role` key (RLS + `REVOKE` locks out direct client access almost everywhere — with one confirmed, still-open exception, see Risk Register).

**Overall implementation readiness: ~55%.** The designs for all 6 in-scope features are sound and reuse-first, but three of them modify the same shared functions (`route()`, `init()`, `resetAll()`) as isolated diffs that were never reconciled against each other, one already-known critical security vulnerability remains untouched by this entire body of work, and the App Store package correctly identifies several hard submission blockers (no native binary, no Privacy Policy, no account deletion) that no feature proposal — including Settings, the natural home for account deletion — currently addresses.

**Overall implementation priority (recommended order, detailed in the Roadmap below):**
1. Fix the pre-existing `chat_groups`/`group_members`/`group_invites` RLS gap (not part of the 6 features, but should precede them — see Risk Register, Critical)
2. Waiting for Moderation polish (near-zero risk, screen + auto-refresh already work)
3. Settings Screen
4. Supabase Reports MVP → Report User → Block User (backend before frontend)
5. Onboarding (after backfill strategy is decided)
6. Lottie Splash Animation (purely additive, no dependencies on anything else)
7. App Store Preparation (ongoing in parallel — legal documents and the native-wrapper decision block submission regardless of feature completion)

---

# Architecture Summary

**Project architecture:** Vanilla JS SPA. No React/Vue/Angular, no npm build step. `index.html` is the shell; `landing.html` is loaded in an iframe as the marketing front door; `app.js` boots on `DOMContentLoaded` and owns all screen rendering and routing via a single `route()` state machine plus a `screens` lookup map and `showScreen(name)`.

**Folder structure:** Flat at the root for frontend files (`index.html`, `landing.html`, `app.js`, `api.js`, `credo.js`, `notifications.js`, `presence.js`, `style.css`, `fcom-effects.js`); `supabase/functions/*/index.ts` for Edge Functions with a shared `_shared/` folder (`response.ts`, `db.ts`, `jwt.ts`, `ratelimit.ts`); two migration locations exist in parallel — a legacy `migrations/` folder (21 files, the original schema) and a newer `supabase/migrations/` folder (6 files, CLI-tracked, numbered 020-025) — this split is a pre-existing, documented inconsistency, not something to fix as part of this handoff, but worth being aware of when adding new migrations (new ones should go in `supabase/migrations/` to match the CLI-tracked convention).

**Design system:** CSS custom properties in `style.css`'s `:root` (`--blue`, `--cyan`, `--gold`, `--muted`, `--font-display`, `--font-mono`, etc.), utility/component classes (`.glass-panel`, `.btn`/`.btn-outline`, `.status-card`, `.status-icon`, `.hint`/`.hint-dev`, `.screen-shell`). `landing.html` maintains its **own** separate `:root` token block with different values — a pre-existing, documented drift, not something any of the 6 proposals touch or should touch.

**Navigation:** A single `route()` function is the sole source of truth for which screen is visible, evaluated as a strict priority ladder (device-blocked → no user → user not found → rejected → phone unverified → pending → approved-no-password → main). `showScreen(name)` hides all `.screen` elements and shows one. No client-side router library, no URL-based routing beyond a single `?open=dashboard` query param.

**State management:** `credo.js` is the synchronous source of truth (reads/writes `localStorage` directly). `api.js` never replaces this — it wraps it. All new local-only state introduced by any proposal (settings, blocked-user cache, onboarding-seen flag) must follow this same pattern: a `credo.js` getter/setter pair backed by a dedicated `localStorage` key, included in `resetAll()`.

**Networking:** Every backend call goes through Deno Edge Functions, authenticated via a bearer JWT (`requireAuthWithRevocation`), never direct Postgres access from the client. A recurring 2-second poll (`api.js` `syncNow`/`startLiveSync`) is the app's only "real-time" mechanism — there is no Supabase Realtime/websocket usage anywhere.

**Supabase architecture:** 11 existing tables (see Database Summary), all access mediated by `service_role` Edge Functions; RLS is enabled and locked down (zero `anon`/`authenticated` grants) on nearly every table — with one confirmed exception that predates and is unrelated to this engagement's 6 proposals.

**Coding conventions:** `handle*` for event handlers, `render*` for DOM-writing functions, `_private` prefix for internal helpers, camelCase throughout, Russian-language UI copy, JSDoc-style block comments at the top of modules and above non-obvious functions, `escapeHtml()` used manually wherever untrusted text is interpolated into `innerHTML` (no framework-level auto-escaping, since there's no framework).

**What MUST NOT be changed** (per explicit lead-developer authority and the "don't redesign" constraint that has governed every phase of this engagement):
- The single-module `app.js`/`credo.js`/`api.js` split and the localStorage-first/server-shadow pattern
- The `route()` priority ladder's existing branch order
- The custom JWT auth model (no migration to Supabase Auth)
- The existing RLS/Edge-Function-only data access model
- The CSS variable design tokens already defined in `style.css`
- The 2-second polling architecture (evolving it to push/Realtime is a separate, larger decision outside this handoff's scope)

---

# Feature Implementation Roadmap

### 1. Settings Screen

- **Objective:** Give users a place to manage account/notification preferences, reusing the existing screen/navigation pattern.
- **Dependencies:** None — self-contained, can be implemented first.
- **Existing reusable components:** `.glass-panel`, `.btn`/`.btn-outline`, existing tab/profile screen structure.
- **Existing reusable services:** None needed beyond `credo.js` itself (local-only for MVP).
- **Existing reusable models:** `users` (read-only, no schema change needed for MVP).
- **Existing reusable navigation:** `screens` map + `showScreen()`.
- **Existing reusable database structures:** None — deliberately scoped local-only to avoid backend impact.
- **Files requiring modification:** `index.html` (new `#screen-settings` section, new button in `#tab-profile`), `app.js` (`screens.settings`, `renderSettingsScreen`, `openSettings`/`closeSettings`, conditional `Notif.checkAndNotify`), `credo.js` (`getSettings`/`getNotificationsEnabled`/`setNotificationsEnabled`, `resetAll()` addition), `style.css` (`.settings-grid`).
- **New files:** None.
- **Risks:** Low — purely additive; the only integration risk is the shared `resetAll()`/`init()` merge noted in the Risk Register.
- **Estimated complexity:** Low.
- **Estimated implementation time:** 0.5–1 day.
- **Recommended order position:** Early (3rd) — low risk, no dependencies, unblocks nothing else but is a good "first real feature" to ship after infrastructure risk items are cleared.

### 2. Report User Flow

- **Objective:** Let approved users report another user for moderation review.
- **Dependencies:** Supabase Reports MVP (backend) must exist first.
- **Existing reusable components:** `openUserProfile()`'s action-button area (`app.js:1088`); no existing modal component — this flow needs the project's first small custom selection UI (reason picker), since `alert()`/`confirm()` can't capture an enum choice.
- **Existing reusable services:** `api.js`'s `_call()` wrapper pattern, `requireAuthWithRevocation` on the backend, `rateLimitDb` shared helper.
- **Existing reusable models:** `users` (for reporter/target lookups).
- **Existing reusable navigation:** None new — surfaces from the existing user-profile view.
- **Existing reusable database structures:** None reused directly; depends on the new `reports` table (see below).
- **Files requiring modification:** `app.js` (`openUserProfile()` extension), `api.js` (new `reportUser()` wrapper).
- **New files:** `supabase/functions/reports/index.ts`.
- **Risks:** Medium — introduces the first non-`alert()`/`confirm()` UI pattern in the project; needs explicit lead sign-off on the interaction design before implementation (flagged in Open Questions).
- **Estimated complexity:** Medium.
- **Estimated implementation time:** 1–1.5 days (including the new selection-UI component).
- **Recommended order position:** After Supabase Reports MVP (4th overall).

### 3. Block User Flow

- **Objective:** Let users unilaterally stop receiving messages from another user.
- **Dependencies:** Supabase Reports MVP's `user_blocks` table must exist first.
- **Existing reusable components:** Same `openUserProfile()` action area as Report.
- **Existing reusable services:** `api.js` wrapper pattern; `messages` Edge Function as the enforcement point.
- **Existing reusable models:** `users`.
- **Existing reusable navigation:** None new.
- **Existing reusable database structures:** None reused directly; depends on the new `user_blocks` table.
- **Files requiring modification:** `app.js` (`openUserProfile()`, `renderChatList()` filtering at `app.js:518`, `openChat()` gating at `app.js:1159`), `api.js` (`blockUser`/`unblockUser`/`refreshBlockedUsers` wrappers, plus a call site inside `syncNow()`), `credo.js` (new local cache helpers, `resetAll()` addition), `supabase/functions/messages/index.ts` (block-check on both `GET` and `POST`).
- **New files:** `supabase/functions/blocks/index.ts`, `supabase/functions/_shared/blocks.ts`.
- **Risks:** Medium — current design only covers 1:1 messaging; group-chat blocking is an explicit, undecided gap (see Risk Register). Also touches the shared `resetAll()`/`syncNow()` hot path, requiring careful manual merge with Settings' and Onboarding's edits to the same functions.
- **Estimated complexity:** Medium.
- **Estimated implementation time:** 1.5–2 days.
- **Recommended order position:** Alongside/immediately after Report (4th–5th overall), same backend dependency.

### 4. Supabase Reports MVP (backend)

- **Objective:** Provide the data model and Edge Functions that both Report and Block depend on.
- **Dependencies:** None — this is the foundation the other two depend on; should be built first among the three.
- **Existing reusable components:** N/A (backend).
- **Existing reusable services:** `_shared/response.ts`, `_shared/db.ts`, `_shared/jwt.ts`, `_shared/ratelimit.ts` — all reused as-is.
- **Existing reusable models:** `users` (foreign keys), `messages` (optional `targetMessageId` reference).
- **Existing reusable navigation:** N/A.
- **Existing reusable database structures:** Follows the same RLS-locked, service-role-only pattern already used by `otp_codes`, `sessions`, `device_blocks`, `rate_limit_log` — explicitly designed as the *opposite* of the vulnerable `chat_groups` pattern.
- **Files requiring modification:** None beyond what's listed under Report/Block above.
- **New files:** One migration (new tables `reports`, `user_blocks`), `supabase/functions/reports/index.ts`, `supabase/functions/blocks/index.ts`, `supabase/functions/_shared/blocks.ts`.
- **Risks:** Low on its own; the design was reviewed and found sound (RLS enabled, zero anon/authenticated grants, DB-level abuse-prevention constraints). Main risk is scope creep into group-chat semantics — keep this migration 1:1-scoped per the current design unless the lead explicitly expands it.
- **Estimated complexity:** Medium.
- **Estimated implementation time:** 1 day (schema + both Edge Functions).
- **Recommended order position:** First among the three Report/Block items (immediately precedes them).

### 5. Lottie Splash Animation

- **Objective:** Add a branded loading animation at app launch.
- **Dependencies:** None — fully independent of every other feature.
- **Existing reusable components:** Dormant `.loader`/`.loader-stack`/`.loader-line` CSS classes in `style.css` (currently unused anywhere in the app) — designed to be reused, not replaced.
- **Existing reusable services:** None.
- **Existing reusable models:** None.
- **Existing reusable navigation:** Sits in front of the existing `init()` flow; does not alter it.
- **Existing reusable database structures:** None.
- **Files requiring modification:** `index.html` (new `#app-splash` element + `lottie.min.js` script tag), `app.js` (orchestration inside `init()`), `style.css` (minor extension of `.loader` rules).
- **New files:** None (no Lottie JSON asset is being authored as part of this proposal — that's explicitly out of scope per the original task).
- **Risks:** Low — the only real risk is timing interaction with the existing `SYNC_EVENT` listener registration if `init()`'s full body (including event wiring) is deferred behind the splash animation; must confirm the sync-event listener attaches promptly regardless of splash duration. Third-party script load (`lottie.min.js`) needs a hard timeout fallback, not just a best-effort one.
- **Estimated complexity:** Low.
- **Estimated implementation time:** 0.5–1 day (excluding animation asset production, which is a design/motion deliverable, not engineering).
- **Recommended order position:** Late (6th) — cosmetic, zero dependencies, safe to slot in anywhere; placed after the higher-value/higher-risk items so it doesn't block them.

### 6. Onboarding

- **Objective:** Walk new users through the app's core concepts (chat, groups, community) on first entry to `main`.
- **Dependencies:** None functionally, but **requires a lead decision on backfill strategy before implementation** (see Risk Register/Open Questions) — this is a blocking prerequisite, not a nice-to-have.
- **Existing reusable components:** `.glass-panel` and sibling visual language reused for new `.onboarding-card`/`.onboarding-step` classes.
- **Existing reusable services:** None.
- **Existing reusable models:** None.
- **Existing reusable navigation:** Inserted into the existing `route()` ladder, immediately before the `main` branch.
- **Existing reusable database structures:** None — local-only (`credo_onboarding_seen`).
- **Files requiring modification:** `index.html` (new `#screen-onboarding` section), `app.js` (`screens.onboarding`, `_onboardingStep` state, render/handler functions, `route()` insertion, `init()` wiring), `credo.js` (`hasSeenOnboarding`/`markOnboardingSeen`, `resetAll()` addition), `style.css` (new onboarding-specific classes).
- **New files:** None.
- **Risks:** **High** until resolved — will interrupt every existing production user on their next login unless a backfill/cutover mechanism is added; also has an unverified interaction with `handleServerSync()`'s 2-second polling while the onboarding screen is visible (see Risk Register).
- **Estimated complexity:** Medium.
- **Estimated implementation time:** 1–1.5 days (plus the backfill mechanism, which is additional scope not yet designed).
- **Recommended order position:** After Settings/Reports/Blocks, once the backfill decision is made (5th overall) — do not implement before that decision is confirmed.

### 7. Waiting for Moderation

- **Objective:** Ensure users awaiting approval have clear, live-updating feedback.
- **Dependencies:** None — the underlying real-time mechanism (`SYNC_EVENT`/`handleServerSync`) already exists and works today; this is a polish pass, not new plumbing.
- **Existing reusable components:** `.status-card`, `.status-icon`, `.hint`/`.hint-dev`, `.btn-outline`.
- **Existing reusable services:** `API.syncNow()` — reused directly by a new manual-refresh button rather than duplicated.
- **Existing reusable models:** `users.status`.
- **Existing reusable navigation:** `route()`'s existing `pending` branch — extended, not restructured.
- **Existing reusable database structures:** None — no schema change.
- **Files requiring modification:** `index.html` (status-meta line + manual refresh button inside `#screen-pending`), `app.js` (`route()`'s pending branch, two small new helper functions, one new `init()` wiring line), `style.css` (one small additive rule).
- **New files:** None.
- **Risks:** Very low — this is the lowest-risk item in the entire roadmap; the screen and its auto-transition already function correctly in production today. The main open question is whether this polish is even wanted, given the core mechanism already works (see Open Questions).
- **Estimated complexity:** Low.
- **Estimated implementation time:** 0.25–0.5 day.
- **Recommended order position:** First (2nd overall, right after the critical RLS fix) — safest possible feature to ship, validates the team's workflow before tackling higher-risk items.

### 8. App Store Preparation

- **Objective:** Prepare metadata, legal documents, and compliance posture for eventual submission.
- **Dependencies:** Fundamentally blocked on a native-wrapper strategy decision that sits outside all 6 feature proposals; also depends on Report/Block actually shipping (Guideline 1.2 compliance) and on an account-deletion flow being added (Guideline 5.1.1(v), currently not scoped into Settings).
- **Existing reusable components:** N/A — this is documentation/compliance work, not UI.
- **Existing reusable services:** N/A.
- **Existing reusable models:** The privacy nutrition label was derived directly from the actual `users`/`messages`/media schema.
- **Existing reusable navigation:** N/A.
- **Existing reusable database structures:** N/A.
- **Files requiring modification:** None (this workstream produces external documents — Privacy Policy, Terms of Service, Community Guidelines — not code).
- **New files:** None in-repo; new documents live outside the codebase (or in a docs folder if the lead wants them versioned there).
- **Risks:** High-to-critical for the *submission timeline* specifically — this is the least "implementation-ready" item on the list because several of its blockers (native wrapper, legal documents, account deletion) require product/legal decisions, not just engineering time.
- **Estimated complexity:** High (mostly non-engineering effort: legal drafting, native wrapper decision, App Store Connect configuration).
- **Estimated implementation time:** Cannot be estimated in engineering days — depends entirely on the native-wrapper decision and legal document authoring timeline, neither of which is an engineering task.
- **Recommended order position:** Runs in parallel with everything else, starting immediately (legal drafting and the wrapper decision have long lead times and don't block other feature work).

---

# Database Summary

**Existing tables (11, confirmed directly from migration files):**
`users`, `otp_codes`, `sessions`, `messages`, `rate_log`, `device_blocks`, `rate_limit_log`, `approval_log`, `chat_groups`, `group_members`, `group_invites`.

**Existing relationships:** `messages` references `users` (`fromId`/`toId`) and optionally `chat_groups` (`groupId`); `group_members`/`group_invites` reference `chat_groups` and `users`; `approval_log` references `users` (actor + target); `sessions`/`otp_codes`/`device_blocks`/`rate_limit_log` are auth/anti-abuse support tables keyed to `users` or raw identifiers (device fingerprint, IP). `users` itself carries the school-scoping column (`school`) that every cross-user Edge Function check filters on.

**Existing RLS policies:** Locked down and correct on `otp_codes`, `sessions`, `device_blocks`, `rate_limit_log`, `approval_log`, and (per the original schema's documented policies) `users`/`messages` — access is either fully `service_role`-only or narrowly scoped (e.g., `users_select_approved_same_school`). **`chat_groups`, `group_members`, and `group_invites` are the confirmed exception** — their migration (`supabase/migrations/20260517153000_024_groups_and_media.sql`) contains no `ENABLE ROW LEVEL SECURITY`, `GRANT`, or `REVOKE` statements at all, re-verified directly this session by searching the file. This is a live, critical, pre-existing gap, unrelated to and unaddressed by any of the 6 feature proposals in this handoff.

**Proposed additions:** Two new tables, `reports` and `user_blocks`, designed to mirror the *correct* existing pattern (RLS enabled, zero `anon`/`authenticated` grants, service-role/Edge-Function-only access), explicitly not the vulnerable `chat_groups` pattern. Proposed abuse-prevention constraints: a partial unique index limiting one open report per reporter→target pair, a unique constraint preventing duplicate blocks, and check constraints preventing self-report/self-block — all enforced at the database level, not just the application level, consistent with the project's existing "fast check + DB constraint" convention (seen today in the rating-cooldown logic).

**Security considerations:** The two new tables' design is sound as proposed. The standing `chat_groups` family gap should be remediated in its own migration, ideally reviewed alongside (or before) the Reports/Blocks migration since both are RLS-focused changes to the same area of the schema. No SQL is included in this handoff document per the task's constraints — the migration text itself was fully specified in the earlier Supabase Reports MVP proposal and is ready for the lead's review there.

---

# UI / UX Summary

**Existing reusable UI:** `.glass-panel` (the project's primary card/panel treatment), `.status-card`/`.status-icon` (used by pending/blocked/verify-phone screens and now extended by Waiting-for-Moderation), `.btn`/`.btn-outline` (universal button styling), `.hint`/`.hint-dev`/`.subtitle` (secondary text treatments), `.toast`/`.toast-container` (the only existing notification/feedback mechanism), `.loader`/`.loader-stack` (dormant, reused by Splash).

**New UI introduced across the 6 proposals:** A settings grid layout (`.settings-grid`), onboarding step cards and dot-indicator (`.onboarding-card`, `.onboarding-step`, `.onboarding-dots`), a splash overlay container, a status-meta/manual-refresh affordance on the pending screen, and — the one genuinely new *interaction pattern*, not just new markup — a reason-selection UI for the Report flow, since the project's existing `alert()`/`confirm()` vocabulary cannot capture an enum choice.

**Design consistency:** Very strong — every proposal was explicitly constrained to reuse existing tokens and component classes; zero new colors, fonts, or spacing scales were introduced anywhere across all 6 features. This is the strongest aspect of the entire body of work.

**Navigation consistency:** All 6 features correctly route through the existing `screens` map / `route()` / `showScreen()` mechanism; none introduce a parallel navigation system. The one nuance requiring verification is Onboarding's insertion point in `route()`'s priority ladder interacting with the always-on 2-second sync loop (see Risk Register).

**Accessibility considerations:** Not deeply addressed by any of the 6 proposals, consistent with the existing app's baseline (no ARIA-heavy patterns found in the original analysis beyond basic semantic HTML). The new reason-selection UI for Report (§ the one new pattern) is the best candidate to set a slightly higher accessibility bar going forward (keyboard-operable, labeled options) since it's new construction rather than an extension of existing markup — worth a explicit ask to whoever implements it, but not a blocker.

---

# Technical Decisions

| Decision | Basis |
|---|---|
| Keep the localStorage-first/server-shadow pattern for all new local-only state (settings, blocked-user cache, onboarding flag) | Existing source code (`credo.js`/`api.js` pattern) |
| New tables (`reports`, `user_blocks`) use RLS-enabled/zero-grant/service-role-only access | Existing source code precedent (`otp_codes`, `sessions`, `device_blocks`) + explicit contrast with the found `chat_groups` vulnerability |
| Report reason selection needs a new (small) custom UI component | Existing source code (confirmed absence of any modal/selection component beyond `alert()`/`confirm()`) |
| Blocking enforcement happens server-side (Edge Function) *and* client-side (chat list filtering) | Inference — defense-in-depth judgment call, not dictated by any single existing pattern, but consistent with the project's general "don't trust the client alone" posture seen in RLS usage elsewhere |
| Onboarding inserted immediately before the `main` branch in `route()` | Existing source code (`route()` structure) — the *placement* is a fact; the backfill strategy is explicitly **not yet decided** (see Open Questions) |
| Splash animation reuses the dormant `.loader` CSS rather than new styles | Existing source code (confirmed `.loader` is currently unused anywhere in the live app) |
| Waiting-for-Moderation's "auto-refresh" already works and needs no new polling mechanism | Existing source code — directly traced and re-verified this session (`api.js` `startLiveSync`/`syncNow`, `SYNC_EVENT`, `app.js` `handleServerSync`, all confirmed wired and active) |
| App Store category recommendation (Social Networking primary, Education secondary — tentative) | Inference from existing source code (school/grade registration fields) — **not confirmed by the lead**, flagged as an open question |
| No native iOS wrapper strategy exists yet | Existing source code (repo-wide search, no Xcode/Capacitor/Cordova artifacts found) |
| Figma is not usable as a design source of truth for any of this work | Confirmed across every phase of this engagement — no Figma file is referenced anywhere in the repository, and Figma MCP has not been connected in the sessions where it was checked |
| Live Supabase schema/RLS state exactly matches what the migration files describe | **Partially inference** — migration files are the best available source this session (Supabase MCP unavailable), but earlier phases of this engagement (when Supabase MCP *was* available) independently confirmed the `chat_groups` grant issue via `information_schema.table_privileges`, so this specific finding is corroborated by two independent methods, not just migration-file reading |

---

# Risk Register

**Critical**
- `chat_groups`/`group_members`/`group_invites` have no RLS enablement and no access revocation — confirmed live and unaddressed by any of the 6 proposals. This should be remediated before or alongside this feature batch, not after.

**High**
- Onboarding will interrupt every existing production user on next login unless a backfill/cutover mechanism is designed before implementation — currently undesigned.
- Missing in-app account deletion — a hard App Store blocker (Guideline 5.1.1(v)) not covered by the Settings Screen proposal or any other proposal in this batch.
- Missing Privacy Policy and Terms of Service (currently dead placeholder links only) — blocks App Store Connect submission configuration entirely, independent of code readiness.
- No native iOS binary/wrapper strategy exists — the fundamental prerequisite for any App Store submission at all.

**Medium**
- Three separate proposals (Settings, Block, Onboarding) each independently edit `resetAll()`; four (Settings, Onboarding, Waiting-for-Moderation, Splash) each independently edit `init()` — must be manually reconciled into single combined diffs, not applied as isolated patches.
- Blocking is currently 1:1-scoped only; a blocked user and blocker can still interact inside a shared group chat — undecided whether this is acceptable for MVP.
- `handleServerSync()`'s interaction with the new Onboarding screen during the always-on 2-second poll is unverified and could cause a re-render/flicker while onboarding is visible.
- Naming similarity between the existing `credo_blocked` (device-level block) and the proposed `credo_user_blocks` (peer-level block) is a real future-confusion risk.
- Adding `refreshBlockedUsers()` to the unconditional 2-second sync tick compounds the already-recurring per-user network cost of the polling architecture.

**Low**
- Splash's third-party script load needs a confirmed *hard* timeout, not just best-effort, to avoid ever blocking app entry.
- Report flow's new reason-selection UI has no established accessibility pattern to follow in this codebase yet — worth a small amount of extra care since it's new construction.
- App Name inconsistency between `index.html` ("Fcom Messenger") and `landing.html` ("Fcom — The Digital Universe") should be resolved before any App Store metadata work.

---

# Open Questions

1. Should the `chat_groups`/`group_members`/`group_invites` RLS fix be scheduled as a standalone, higher-priority task ahead of this entire feature batch?
2. What is the backfill/cutover strategy for Onboarding so existing users aren't unexpectedly interrupted?
3. Is 1:1-only blocking acceptable for MVP, or must group-chat blocking be in scope before Block User ships?
4. Should `credo_user_blocks` be renamed to avoid confusion with the existing `credo_blocked` device-block key?
5. Should `refreshBlockedUsers()` run on every 2-second tick, or only on login/status-change?
6. Is account deletion being deliberately deferred, or should it be added to the Settings Screen scope before implementation begins?
7. What is the actual intended user base — specifically, does it include minors, and if so what age-verification/compliance posture is required? This single answer changes the Age Rating, Category, Privacy Policy content, and legal risk profile more than any other decision in this handoff.
8. Is a native-wrapper strategy (WKWebView shell, Capacitor, native rewrite, or other) already decided outside this repository?
9. Which App Name is canonical — "Fcom Messenger" or "Fcom — The Digital Universe"?
10. Is `auto_approve_first`'s current live behavior (previously flagged as possibly a no-op) confirmed one way or the other, since it affects how an App Review test account would be bootstrapped?
11. Is the Waiting-for-Moderation polish (manual refresh button) even wanted, given the underlying auto-transition already works correctly today without it?
12. Does the Reports/Blocks migration need to be bundled with a `chat_groups` RLS-hardening migration in the same review/deploy cycle, since both touch the same area of the schema?

---

# Development Checklist

☐ Review this handoff document in full with the lead developer
☐ Resolve Open Questions #1–#12 (or explicitly defer specific ones with a documented decision)
☐ Fix `chat_groups`/`group_members`/`group_invites` RLS gap (Critical risk — recommended before any feature work below)
☐ Confirm design/token reuse plan for all new UI (no new colors/fonts — already validated, just needs sign-off)
☐ Confirm database plan for `reports`/`user_blocks` (schema reviewed, no SQL executed yet)
☐ Implement Waiting for Moderation polish (lowest risk, validates workflow)
☐ Implement Settings Screen
☐ Implement Supabase Reports MVP (schema + Edge Functions)
☐ Implement Report User flow (depends on Reports MVP)
☐ Implement Block User flow (depends on Reports MVP; requires resolved group-chat-scope decision)
☐ Reconcile combined `resetAll()`/`init()` diffs across Settings/Block/Onboarding/Waiting-for-Moderation/Splash before merging
☐ Decide and implement Onboarding backfill strategy
☐ Implement Onboarding flow
☐ Integrate Lottie Splash Animation
☐ Verify `SYNC_EVENT` listener registration timing isn't delayed by splash orchestration
☐ Author Privacy Policy, Terms of Service, Community Guidelines
☐ Decide native-wrapper strategy for iOS distribution
☐ Add in-app account deletion (Settings extension)
☐ Reconcile App Name and finalize App Store metadata
☐ Internal QA across all shipped features together (not just individually)
☐ Re-verify RLS/grants on all new and modified tables in the live Supabase project
☐ Final architecture/security review before submission
☐ App Store Connect submission (only after all blockers above are cleared)

---

# Final Readiness Assessment

**Implementation readiness score: 6/10** — Every feature has a clear, detailed, reuse-first design ready to hand to an engineer. The deduction is for the unresolved mechanical merge conflicts (§ Risk Register, Medium) and the two decisions (Onboarding backfill, group-chat blocking scope) that block starting those two specific features safely today.

**Architecture consistency score: 8/10** — All 6 proposals correctly extend the existing single-module, localStorage-first, Edge-Function-mediated architecture with no parallel systems introduced. The deduction is for the compounding size/complexity being added to `app.js`'s single-module design without any proposal suggesting even lightweight internal organization — acceptable under "don't redesign," but worth tracking as debt.

**Code quality confidence score: 7/10** — No code has actually been written yet (this entire engagement has been proposal-only), so this score reflects confidence in the *designs'* quality: naming conventions, error handling patterns, and reuse discipline are all consistent with the existing codebase's conventions in every proposal reviewed. The deduction reflects the complete absence of test coverage in the underlying project, which means none of these designs can be mechanically verified before manual QA.

**Maintainability score: 6/10** — Reuse discipline is excellent, but three separate proposals touching the same shared functions (`resetAll()`, `init()`) without cross-referencing each other is exactly the kind of thing that erodes maintainability if not caught before implementation (which this handoff does catch). The standing `app.js` size and lack of tests are pre-existing, not newly introduced, but they cap how high this score can reasonably go regardless of how well these 6 features are built.

**App Store readiness score: 3/10** — Multiple hard blockers remain: no native binary/wrapper, no Privacy Policy, no Terms of Service, no account deletion, no content-level moderation, and an unresolved tension between the likely-minors audience and the conservative age rating the current lack of moderation would otherwise require. Account-level moderation (approve/reject) does work correctly today, which is the one bright spot in this score.

**Deployment readiness score: 4/10** — The web application itself could be safely deployed today with just the Waiting-for-Moderation polish and Settings Screen (both low-risk, well-isolated). Deploying Report/Block, Onboarding, or Splash without first resolving the merge-conflict and backfill/scope questions above risks visible regressions for existing users or silent security inconsistency (the still-open `chat_groups` gap sitting alongside newly-hardened `reports`/`user_blocks` tables would be an odd, avoidable state to ship in).

---

No project files were modified, no commits or branches were created, no database changes were executed, and nothing was deployed in the preparation of this document. This concludes the planning phase; implementation decisions from here are the lead developer's.