Before the task-by-task plan, one structural fact needs to be flagged up front because it materially changes the scope of two of the eight tasks.

## Critical scoping flag (read first)

**Fact (existing source code):** This project is a static vanilla HTML/CSS/JS web app (`index.html`, `app.js`, `credo.js`, `api.js`, etc.) served as a single-page app, backed entirely by Supabase Edge Functions. There is no Xcode project, no `Info.plist`, no Swift/SwiftUI code, no Capacitor/Cordova/React Native wrapper, and no App Store distribution pipeline anywhere in this repository. The only iOS/React‑Native references found are generic reference CSVs bundled inside the unrelated `ui-ux-pro-max` skill folder — they are not part of the product.

This means:
- **"Lottie Splash Animation"** is fully implementable as-is — Lottie has an official web renderer (`lottie-web`) that works with plain `<script>` tags, no build step required. Planned below as a web splash.
- **"App Store Connect Metadata"** cannot be actioned as a native distribution task from this repo alone — there is no native app target to submit. It only makes sense if (a) there's a separate native/wrapper project not in this repository, or (b) the plan is to wrap this PWA (e.g., via Capacitor/PWABuilder) for App Store distribution, which would itself be an architectural decision reserved for the lead developer. I have planned it below strictly as the **content/compliance deliverable** (listing text, screenshots, privacy answers) that is independent of the wrapping technology, and flagged the wrapper decision as an open question.

I did not find a Figma file reference (URL, file key, or node id) anywhere in the codebase, `README.md`, or other docs for this project. The Figma MCP account is connected (`whoami` succeeded, viewer/"View" seat), but with no project file key to query, I did not guess one — per your instruction not to assume when I lack the information. Every task below that references Figma states explicitly that **no project Figma file was found**; if one exists, please share the URL so designs can be pulled with `get_design_context`.

---

## 1. Lottie Splash Animation

### Overview
- **Goal:** Show a branded loading/splash animation while the app initializes, replacing or augmenting the current plain CSS loader.
- **Estimated complexity:** Low
- **Estimated implementation time:** 0.5–1 day
- **Dependencies:** None blocking. Decision needed on scope (landing page vs. app shell — see Recommendations).

### Existing Project Analysis
- **Existing files to reuse:**
  - `landing.html` lines ~1174-1178 (`#loader`, `.loader-stack`, `.loader-kicker`, `.loader-mark`, `.loader-line`) — the only splash/loader element that currently exists in the product. *(Existing source code)*
  - `fcom-effects.js` `initLoader()` — currently just waits ~700ms and toggles `.is-hidden` on `#loader`. This is the exact hook point to swap in a Lottie animation's `complete` callback instead of a fixed timeout. *(Existing source code)*
  - `style.css` lines 383-448 — a **near-duplicate, apparently unused** copy of `.loader`/`.loader-mark`/`.loader-line` classes (not referenced by `index.html`, which has no `#loader` element at all). This is dead/legacy CSS worth flagging to the lead developer rather than building on top of blindly. *(Existing source code / Inference)*
- **Existing components to reuse:** `.loader` overlay pattern (`position: fixed; inset: 0; backdrop-filter: blur(20px); z-index: 100`) as the splash container shell — only the center content changes from text to a Lottie canvas/SVG. *(Existing source code)*
- **Existing services to reuse:** None needed — this is a pure presentation feature, no `api.js`/`credo.js` involvement.
- **Existing navigation to reuse:** None — splash is not a `showScreen()` state, it's an overlay above the current screen, matching the current implementation's pattern.
- **Existing design tokens/styles to reuse:** `--blue`, `--cyan` gradient tokens already used in `.loader-line::after`; `var(--font-display)` for any accompanying wordmark text kept alongside the animation. *(Existing source code)*
- **Existing database tables:** None applicable.

### Required Changes
- **Files requiring modification:** `landing.html` (swap loader markup/behavior), `fcom-effects.js` (`initLoader()` logic), possibly `style.css` (add or clean up loader styles).
- **New files needed:**
  - A Lottie JSON asset (e.g. `assets/splash.json`) — must be supplied by design/lead dev; no such asset exists in the repo today.
  - `lottie.min.js` (self-hosted, consistent with the project's no-CDN-dependency, no-bundler convention already followed by every other script) or a `<script>` reference if the lead developer is fine with a CDN dependency (a first for this project — currently zero third-party runtime scripts are used).
- **Database changes:** None.
- **API changes:** None.
- **Navigation changes:** None, if scoped to the existing landing-page loader. If extended to the app shell (`index.html`), a new overlay element and a call site in `app.js`'s `init()`/`route()` would be needed — see open question below.

### Risks
- **Architectural risk:** Low. Introduces the project's first third-party runtime library (`lottie-web`, ~40-60KB min+gzip depending on renderer). This is a small but real precedent-setting change for a project that currently ships zero dependencies — worth explicit lead-developer sign-off. *(Inference, based on observed zero-dependency convention)*
- **UI/UX risk:** A splash that's too long frustrates users; must stay short (~800ms-1.5s) and skippable/timeout-boxed so a slow network doesn't block the JSON asset from loading indefinitely (need a fallback timeout to fall back to the current CSS loader if the Lottie asset fails to load).
- **Database risk:** None.
- **App Store review risk:** Not applicable (web app, no App Store submission from this repo).

### Recommendations
- **Suggested implementation approach:** Keep the existing `#loader` DOM/CSS shell in `landing.html`, replace only the inner content with a `<div id="lottie-splash">` container, call `lottie.loadAnimation({ container, renderer: 'svg', loop: false, autoplay: true, path: 'assets/splash.json' })` and hide the overlay on the animation's `complete` event (with a hard-coded timeout fallback, e.g. `Math.min` of animation duration and current 700ms floor) — this is the officially documented pattern per Context7's `lottie-web` docs (`loadAnimation`, `renderer: 'svg'`, `.destroy()` for cleanup). Self-host `lottie.min.js` next to the other vendor-free scripts to preserve the project's no-external-CDN convention. *(Context7 + Existing source code)*
- **Suggested implementation order:** (1) obtain/confirm the Lottie JSON asset from design, (2) self-host `lottie-web`, (3) wire into `fcom-effects.js`'s `initLoader()`, (4) verify on slow-network throttling that the fallback timeout works, (5) only then consider extending to the app shell if requested.
- **Questions for the lead developer:**
  1. Is this splash meant for the **landing page only** (where a loader already exists) or also for the **app shell** (`index.html`/`app.js`), which currently has no loading screen at all while `credo.js`/`api.js` initialize?
  2. Is a new third-party runtime dependency (`lottie-web`) acceptable, or is a CSS/SVG-only animation preferred to preserve the zero-dependency footprint?
  3. Who supplies the actual Lottie JSON asset (design team / After Effects export)? None exists in the repo currently.

---

## 2. Settings Screen

### Overview
- **Goal:** Give users a dedicated place to manage account-level preferences (currently there is none beyond the read-only Profile tab).
- **Estimated complexity:** Medium (mostly UI; complexity depends heavily on which settings are in scope — see open question).
- **Estimated implementation time:** 2-4 days for a basic settings screen (logout, notification toggle, avatar/photo management using the existing upload-media function, account info display); more if password change / data export / account deletion are required.
- **Dependencies:** Should follow after Onboarding/decisions on navigation model are settled, since both touch the Profile tab area.

### Existing Project Analysis
- **Existing files to reuse:** `index.html` (`#screen-...` pattern for a new `#screen-settings`), `app.js` (`showScreen`, `showTab`, `_renderProfileContent` helper for any profile summary shown at the top of Settings), `style.css` (`.glass-panel`, `.profile-card`, `.btn`/`.btn-outline`/`.btn-small`).
- **Existing components to reuse:** `Avatar.html()` (`avatars.js`) for the account avatar row; `Notif.showToast()` (`notifications.js`) for save-confirmation feedback, consistent with how the rest of the app confirms actions.
- **Existing services to reuse:** `api.js` — specifically `API.logout()` (already implemented and used elsewhere, e.g. in `handleLogout`/admin flows per prior analysis), and `API.uploadMedia()` if avatar-change is in scope (used today for chat images per `groups/index.ts`/`upload-media/index.ts`). `Credo.updateUser()` for any locally-mutable profile fields, following the localStorage-first/optimistic pattern the rest of the app uses.
- **Existing navigation to reuse:** The `showScreen()` state machine and the existing Profile tab (`tab-profile`) as the natural entry point.
- **Existing design tokens/styles to reuse:** All existing `:root` CSS variables in `style.css`; `.card`, `.card-body`, `.toast` patterns for list-style settings rows.
- **Existing database tables/structures to reuse:** `users` table for any persisted preference that must sync across devices (e.g. notification opt-out) — would need a new column (see below) rather than a new table, consistent with how `role` was added to `users` in migration 022.

### Required Changes
- **Files requiring modification:** `index.html` (new screen markup), `app.js` (render/open/close functions, event wiring), `style.css` (if any new visual pattern is needed), `api.js` only if a new preference must sync to the backend.
- **New files needed:** None necessarily — can live inside `app.js`/`index.html` following the existing single-module convention, unless the lead developer wants to start splitting `app.js` (currently monolithic).
- **Database changes:** Only if a preference must be server-persisted (e.g., `users.notifications_enabled BOOLEAN DEFAULT true`) — a new migration following the existing timestamped `supabase/migrations/*.sql` convention (e.g., mirroring how migration 022 added `role`). If all settings are device-local (e.g., "clear local cache"), no DB change is needed at all.
- **API changes:** Only if server-synced preferences are introduced — would need either a new Edge Function or an extension of an existing one (e.g. folding a `PATCH /me` style operation into the existing user-update surface, if one exists — not confirmed from the prior analysis; needs lead-developer input).
- **Navigation changes:** Either (a) a new bottom-nav tab, or (b) a button inside the existing Profile tab that calls `showScreen('settings')` — see recommendation below.

### Risks
- **Architectural risk:** Low-medium. If settings need to be device-synced, this is the first place (outside auth/cred/messages) where a new server-synced user preference would be introduced, touching the localStorage-first sync pattern in `api.js`/`_syncCurrentUser()`. Should follow that exact pattern rather than inventing a new sync path.
- **UI/UX risk:** The bottom nav currently has a fixed, `flex-wrap`-based row of tabs sized for 4 items (`display:flex; flex-wrap:wrap`, `flex:1` per button on mobile). Adding a 5th tab will visually crowd the nav on narrow viewports; hanging Settings off the Profile tab avoids this at the cost of one extra tap.
- **Database risk:** Any new `users` column must be added with `REVOKE`/RLS consistent with the project's existing guarded-column pattern (recall `cred` and `status` are only writable via `SECURITY DEFINER` functions/Edge Functions, never directly) — a naive `ALTER TABLE users ADD COLUMN` without matching grants could accidentally be left directly writable by `anon`/`authenticated`, which was the exact class of bug found in the `chat_groups` RLS gap during the prior audit. This must be reviewed carefully against the existing RLS/REVOKE pattern.
- **App Store review risk:** Not applicable to this repo's distribution model as it stands (see top-level flag).

### Recommendations
- **Suggested implementation approach:** Add Settings as a sub-screen reached from the Profile tab (`showScreen('settings')`), not a new bottom-nav tab, to avoid disturbing the existing 4-tab nav layout. Keep all preferences device-local (localStorage via `credo.js`) unless a specific preference genuinely needs cross-device sync — this avoids any new backend surface and keeps the task Low-Medium complexity. *(Inference, based on existing nav layout and localStorage-first convention)*
- **Suggested implementation order:** (1) confirm exact settings scope with lead dev, (2) build the screen with logout + account info (zero backend risk), (3) layer in avatar management (reuses existing `uploadMedia`), (4) only then consider any server-synced preference with its own migration/RLS review.
- **Questions for the lead developer:**
  1. What settings are actually in scope? (Notification toggle, password change, avatar change, language, data export, delete account, logout — each has very different complexity/DB impact.)
  2. Should Settings be a 5th bottom-nav tab or accessed from within the Profile tab?
  3. Is there an existing "update my profile" Edge Function/RPC not surfaced in the prior analysis, or would one need to be created from scratch for any editable field?

---

## 3. Onboarding

### Overview
- **Goal:** Introduce first-time users to the app's concept (Credo/rating system, approval-gated access, etc.) before or during registration.
- **Estimated complexity:** Low-Medium
- **Estimated implementation time:** 1.5-3 days for a simple multi-step intro; more if it needs to be interactive/personalized.
- **Dependencies:** None technical; needs product/content input (copy, illustrations) and a scope decision (see below).

### Existing Project Analysis
- **Existing files to reuse:** `index.html` (`.screen` pattern, `#screen-register` as the natural "next" destination), `app.js` (`showScreen()` state machine), `style.css` (`.glass-panel`, `.btn`, `.btn-outline`).
- **Existing components to reuse:** None directly reusable for a carousel/stepper — **no multi-step/carousel UI component exists anywhere in the current codebase.** This would be a new (but simple) pattern, built from the existing `.screen`/`.btn` primitives.
- **Existing services to reuse:** `credo.js`'s `loadJSON`/`saveJSON` localStorage helpers — to persist a `hasSeenOnboarding` flag, consistent with how `getDeviceAccountIds`/`isDeviceBlocked` already store simple flags in localStorage.
- **Existing navigation to reuse:** The `showScreen()` mechanism; onboarding would slot in as a new screen(s) shown before `screen-register`/`screen-login` on first load.
- **Existing design tokens/styles to reuse:** All existing `:root` tokens; `landing.html`'s copywriting/visual tone (`fcom-effects.js` particle/cursor effects) if onboarding is meant to feel like a continuation of the marketing landing experience rather than the plainer app-shell screens.
- **Existing database tables/structures to reuse:** None — this is a pure first-run, client-local concern; no server state needed.

### Required Changes
- **Files requiring modification:** `index.html` (new screen(s)), `app.js` (routing logic to insert onboarding before register/login on first visit, gated by the localStorage flag), `style.css` (any new step-indicator/carousel styling).
- **New files needed:** Possibly none if kept small enough to live in `app.js`/`index.html`; a dedicated `onboarding.js` module could be justified if the step logic gets non-trivial, following the existing pattern of one file per concern (`avatars.js`, `presence.js`, `notifications.js`).
- **Database changes:** None (unless the lead developer wants server-side onboarding-completion analytics, in which case a very small table or a boolean column would be needed — not assumed here).
- **API changes:** None.
- **Navigation changes:** Yes — the initial route decision in `app.js`'s `init()`/`route()` needs a new branch: "no onboarding flag → show onboarding → then register/login," which touches the existing first-load logic that decides between `screen-register`, `screen-login`, `screen-pending`, `screen-main`, `screen-blocked` based on stored device/user state.

### Risks
- **Architectural risk:** Low. Purely additive to the existing screen/routing state machine; no backend involvement.
- **UI/UX risk:** Medium — inserting a new mandatory step before registration adds friction for a product whose funnel (register → OTP → password → pending approval) is already multi-step; onboarding length must be kept minimal (2-4 short screens) to avoid drop-off. Also must be carefully skip-able/idempotent given the existing device-fingerprint/anti-abuse checks run at registration — onboarding itself should not touch `device_blocks` logic at all.
- **Database risk:** None, if kept fully client-local as recommended.
- **App Store review risk:** Not applicable to this repo's distribution model.

### Recommendations
- **Suggested implementation approach:** Implement as 2-4 new `.screen` sections shown once (gated by a `localStorage` flag written via `credo.js`-style helpers), inserted into the existing routing logic ahead of `screen-register`. Reuse `.glass-panel`/`.btn` visual language rather than introducing new visual primitives. *(Inference, consistent with existing localStorage-first + screen-based routing conventions)*
- **Suggested implementation order:** (1) agree on content/step count with product owner, (2) build static screens with the existing style primitives, (3) wire the first-run gate into routing, (4) QA against all existing entry states (fresh device, blocked device, already-pending user, already-approved user) to make sure onboarding never re-appears for returning users or interferes with the `screen-blocked`/`screen-pending` states.
- **Questions for the lead developer:**
  1. Is "onboarding" a pre-registration explainer (my assumed scope, since nothing like it exists today), or is it meant to enhance the existing register → OTP → password → pending funnel itself?
  2. Should onboarding re-appear after app updates (versioned flag) or truly only once ever per device?
  3. Who owns the content/copy and any illustrations — is there a Figma file for this? (None was found in the repo or resolvable via the Figma MCP without a file key.)

---

## 4. Waiting for Moderation Screen

### Overview
- **Goal:** Show a clear "your account is pending approval" state to newly registered users.
- **Estimated complexity:** Low — **this already exists** and likely only needs enhancement, not a rebuild.
- **Estimated implementation time:** 0.5-1.5 days if scoped as an enhancement of the existing screen; more only if "moderation" is redefined to mean content moderation (see question below).
- **Dependencies:** None.

### Existing Project Analysis
- **Existing files to reuse (major finding):** `index.html` already defines `#screen-pending` — a dedicated screen shown after registration with copy equivalent to "Заявка отправлена" (application submitted), the user's nickname, explanatory hint text, and a "Вернуться на лендинг" (return to landing) button. This is functionally the "Waiting for Moderation" screen the task asks for. *(Existing source code — direct match, not inference)*
- **Existing components to reuse:** Whatever avatar/status treatment `screen-pending` already uses; `Avatar.html()` if the screen should show the user's own generated avatar (needs verification against current markup — recommend reviewing before extending).
- **Existing services to reuse:** `credo.js`'s user-status handling (`status: 'pending'`), `api.js`'s polling/sync (`syncNow` every 2s) which is exactly what currently promotes a user out of this screen once an admin approves them via `approve`.
- **Existing navigation to reuse:** `showScreen('pending')`, already wired into the routing logic after registration completes.
- **Existing design tokens/styles to reuse:** Existing screen/card styles already applied to `#screen-pending`.
- **Existing database tables/structures to reuse:** `users.status` (`pending`/`approved`/`rejected`), `approval_log` (append-only audit trail of every approve/reject decision, already trigger-populated per migration 013) — both already fully support this screen's needs with zero DB changes required.

### Required Changes
- **Files requiring modification:** `index.html`/`app.js`/`style.css` — only if visual/copy enhancements are requested (e.g., estimated wait time, progress indicator, live "X people are reviewing your request" style messaging, contact/support link).
- **New files needed:** None expected.
- **Database changes:** None expected — `users.status` and `approval_log` already model this fully.
- **API changes:** None expected, unless a new "estimated wait time" or "position in queue" metric is desired, which would require new read-only logic (e.g., extending `adminStats`-style aggregation, or a new lightweight Edge Function) — not currently exposed anywhere.
- **Navigation changes:** None expected.

### Risks
- **Architectural risk:** Very low — this is enhancement of an existing, working screen.
- **UI/UX risk:** Low. Main risk is scope creep if "moderation" is reinterpreted as content moderation (see question) rather than account approval, which would turn this into a materially different (and much larger) feature tied to task 7.
- **Database risk:** None if scope stays as account-approval status display.
- **App Store review risk:** Not applicable.

### Recommendations
- **Suggested implementation approach:** Treat this primarily as a design/content refresh of the existing `#screen-pending`, not a new build. Confirm current exact markup/behavior with the lead developer before touching it, since it's a live production screen already relied upon by every new registrant. *(Existing source code)*
- **Suggested implementation order:** (1) review current `#screen-pending` markup/behavior end-to-end, (2) gather desired enhancements, (3) implement as a scoped visual/copy update, (4) verify against the live 2s polling transition to `screen-main` on approval, so no regressions are introduced in that transition.
- **Questions for the lead developer:**
  1. Does "Waiting for Moderation" refer to the **existing** account-approval pending screen, or is this actually about a **new** concept of content/message moderation (which would instead be part of tasks 6/7)? The naming overlaps and needs disambiguation before scoping further.
  2. Are there specific enhancements desired (estimated wait time, ability to cancel/edit the application, contact support), or is this purely a visual polish pass?

---

## 5. Report User Flow

### Overview
- **Goal:** Let a user report another user (e.g. for abusive behavior) for admin review.
- **Estimated complexity:** Medium
- **Estimated implementation time:** 3-5 days (client UI + new Edge Function + new table + RLS), tightly coupled with task 7.
- **Dependencies:** Requires task 7 (Supabase Reports MVP) to exist first — the report table/Edge Function is the backend for this exact flow. Should be planned and estimated together.

### Existing Project Analysis
- **Existing files to reuse:** `app.js`'s `openUserProfile()`/`openChat()` (natural entry points — a "Report" action would live in `#user-profile-actions` next to the existing "Написать"/"Мой профиль" buttons, and/or in the chat header next to `#chat-partner-profile-btn`). *(Existing source code)*
- **Existing components to reuse:** None for the reason-selection UI itself — **no modal/dialog/bottom-sheet component exists anywhere in the codebase today.** The entire app uses only native `alert()`/`confirm()` for confirmations (verified: 14+ call sites, all native browser dialogs) and a `.toast` component for transient notifications. A reason-picker for reports needs more structure than `confirm()` can offer, so this will be the **first custom overlay/modal pattern** introduced in the project — should be built minimally and consistently with existing visuals (`.glass-panel` look, `.btn` classes), not as a new heavyweight UI framework. *(Existing source code — confirmed via full-file scan)*
- **Existing services to reuse:** `api.js`'s `_call()` HTTP helper pattern (used by every existing Edge Function call — `register`, `login`, `approve`, `createGroup`, etc.) should be extended with a new `API.reportUser()` following the exact same shape.
- **Existing navigation to reuse:** `openUserProfile()`/`openChat()` screens as the trigger surfaces; no new top-level screen/nav entry needed if implemented as an action + confirmation, not a dedicated `showScreen()` state.
- **Existing design tokens/styles to reuse:** `.btn-outline`/`.btn-small` for a "Report" action button; `Notif.showToast()` for post-submit confirmation, consistent with how other actions confirm success today.
- **Existing database tables/structures to reuse (pattern to copy, not schema to reuse directly):** `approval_log` (migration 013) is the closest existing analog — an append-only audit table with `actorId`/`targetId`/`action`, RLS restricted to participants, no direct client INSERT/UPDATE/DELETE (writes only via a trusted Edge Function/trigger with `service_role`), and a `CHECK` preventing self-action. The new reports table should follow this exact pattern. *(Existing source code / Supabase MCP — confirmed via migration file inspection)*

### Required Changes
- **Files requiring modification:** `app.js` (add Report action + minimal reason modal + submit handler), `api.js` (`API.reportUser()`), `index.html` (modal markup, new button in profile/chat actions), `style.css` (new minimal modal/overlay classes).
- **New files needed:** New Edge Function `supabase/functions/report-user/index.ts` (or similar), following the existing per-endpoint Edge Function convention seen in `groups/index.ts`, `upload-media/index.ts`.
- **Database changes:** New migration adding a `user_reports` table (see task 7 for full detail) — this is shared infrastructure with task 7, not separate work.
- **API changes:** New endpoint (`report-user` or folded into a broader `reports` function alongside admin-review actions).
- **Navigation changes:** None structural — action-based, not a new screen, unless the lead developer wants a dedicated "My Reports" history screen (not assumed here).

### Risks
- **Architectural risk:** Medium. This is the first client-triggered "moderation-adjacent" write outside the existing approve/reject/rate patterns; must be built with the same `SECURITY DEFINER`/Edge-Function-only-write discipline used elsewhere, or it risks becoming the next `chat_groups`-style RLS gap (the critical vulnerability found in the prior audit, where new tables were shipped with RLS disabled and full `anon`/`authenticated` grants).
- **UI/UX risk:** Introducing the app's first modal/overlay component is a new interaction pattern; needs to feel consistent with the existing toast/`.glass-panel` visual language, not bolted-on. Also needs clear rate-limiting/anti-spam UX (e.g., "you've already reported this user") to prevent report-flooding, mirroring the existing `ratelimit.ts` shared module used elsewhere in Edge Functions.
- **Database risk:** A poorly-scoped RLS policy on the new `user_reports` table is the single biggest risk here, given the project's documented history of exactly this class of bug (`chat_groups`/`group_members`/`group_invites` RLS gap found in the prior audit). Must be reviewed against `approval_log`'s proven pattern before shipping.
- **App Store review risk:** Not applicable to this repo's current distribution model, but worth noting for the lead developer: if this ever ships as a native/wrapped app, Apple's Guideline 1.2 (User Generated Content) generally *requires* a mechanism to report objectionable content and block abusive users for apps with UGC/messaging — so this task (and task 6) are effectively **prerequisites**, not optional nice-to-haves, for any future App Store submission. *(Inference, based on general App Store review guidelines knowledge — not verified against this project's specific submission plans)*

### Recommendations
- **Suggested implementation approach:** Build the minimal modal, the `user_reports` table (task 7), and the Edge Function together as one unit of work rather than as separate tasks, since a report UI with no backend (or vice versa) isn't independently shippable. Reuse `approval_log`'s RLS/audit pattern exactly. *(Existing source code + Inference)*
- **Suggested implementation order:** (1) design `user_reports` schema + RLS (task 7), (2) build the Edge Function, (3) add `API.reportUser()`, (4) build the minimal report-reason modal UI, (5) wire the action button into profile/chat, (6) add basic admin visibility (extending `renderAdminTab()`).
- **Questions for the lead developer:**
  1. What are the report reason categories (spam, harassment, fake account, inappropriate content, other)? Not documented anywhere.
  2. Should a report auto-flag/hide content pending review, or only notify admins passively (as the current admin tab does for stats)?
  3. Is a generic first modal/overlay component acceptable as a new UI pattern, and should it be built reusably for future needs (e.g., block confirmation, task 6) rather than one-off?

---

## 6. Block User Flow

### Overview
- **Goal:** Let a user block another user so they can no longer message or see each other.
- **Estimated complexity:** Medium
- **Estimated implementation time:** 2-4 days
- **Dependencies:** Best implemented alongside task 5 (shares the new modal component and profile/chat action-button surface); independent of task 7's report table (separate underlying data).

### Existing Project Analysis
- **Existing files/behavior that must NOT be confused with this task:** `credo.js`'s `isDeviceBlocked`/`blockDevice` and the `device_blocks` table (migration 006) implement **device-level anti-abuse blocking** (preventing a rejected applicant from re-registering on the same device) — this is a completely different concept from **user-to-user blocking** (preventing two approved users from contacting each other). The existing `screen-blocked` in `index.html` is for the device case only and should not be reused/repurposed for this feature. *(Existing source code — important disambiguation, not assumption)*
- **Existing files to reuse:** `app.js`'s `openUserProfile()` (`#user-profile-actions`) and `openChat()` header (`#chat-partner-profile-btn` area) as the trigger surface, same as task 5.
- **Existing components to reuse:** The same new minimal modal/confirmation pattern proposed in task 5 (a simple native `confirm()` may actually be sufficient here, since blocking is a single yes/no action unlike report's reason-selection — worth deciding once, reused for both).
- **Existing services to reuse:** `api.js`'s `_call()` pattern for a new `API.blockUser()`/`API.unblockUser()`; `credo.js`'s local-state patching convention (`_patchCredo`) so blocking updates local chat/user lists immediately (optimistic UI), consistent with how every other write in this app behaves.
- **Existing navigation to reuse:** No new screen needed for the action itself; however, a "Blocked users" management list (to unblock someone) would need a new small screen or a section within the proposed Settings screen (task 2) — natural synergy point.
- **Existing design tokens/styles to reuse:** Same `.btn`/`.card`/`.toast` primitives as elsewhere.
- **Existing database tables/structures to reuse (pattern):** Again closest to `approval_log`'s actor/target audit-log shape, but this one is **not append-only** — blocks need to be revocable (unblock), so it's closer to a mutable relationship table. No existing table fits directly; a new `user_blocks` table is needed (see below), but should copy the RLS/REVOKE discipline from `approval_log`/`device_blocks`.

### Required Changes
- **Files requiring modification:** `app.js` (block/unblock actions + hiding blocked users from chat lists/user discovery), `api.js` (`API.blockUser()`/`API.unblockUser()`), `credo.js` (local blocked-user-list helpers, mirroring existing getters like `getChatPartners`), `index.html` (button + possibly a blocked-users list screen).
- **New files needed:** New Edge Function `supabase/functions/block-user/index.ts` (handles both block and unblock, or split into two, following the existing convention of small focused functions like `approve`/`reject`).
- **Database changes:** New migration for a `user_blocks` table: `blockerId`, `blockedId`, `createdAt`, unique constraint on `(blockerId, blockedId)`, `CHECK (blockerId <> blockedId)` (mirroring `approval_log_no_self_action`), RLS restricting visibility to the blocker only, writes only via Edge Function with `service_role`.
- **API changes:** New endpoints for block/unblock; existing message-sending/user-listing logic in Edge Functions (or client-side filtering in `getUsersToRate`/`getChatPartners`/discovery lists) needs to respect the block relationship — this is the largest hidden scope item, since blocking must be enforced **everywhere** two users could otherwise interact (chat, rating, group invites, user discovery lists), not just at the point of the block action itself.
- **Navigation changes:** Only if a "Blocked users" management screen is added (recommended to fold into Settings, task 2).

### Risks
- **Architectural risk:** Medium-High relative to its apparent simplicity — enforcing a block consistently requires touching multiple existing read paths (`getUsersToRate`, `getChatPartners`, group messaging, rating eligibility) that were not designed with a "hidden relationship" concept in mind. Under-enforcing it (e.g., blocking chat but not rating) would be a real product/trust bug.
- **UI/UX risk:** Needs a clear, discoverable way to view/manage/undo blocks (Settings synergy noted above), or users will feel blocking is a "black box" action.
- **Database risk:** Same class of risk as task 5 — a new table must be shipped with correct RLS and `REVOKE`s from day one, following `approval_log`'s proven pattern, to avoid repeating the `chat_groups` RLS gap found in the prior audit.
- **App Store review risk:** As with task 5 — blocking is generally an *expected/required* capability for UGC/messaging apps under Apple's guidelines if this product is ever wrapped for App Store distribution. *(Inference)*

### Recommendations
- **Suggested implementation approach:** Scope this task explicitly to include an audit of every existing user-to-user surface (`getUsersToRate`, `getChatPartners`, group invites, chat send) that must now check the new block relationship, rather than treating it as "just add a button." *(Existing source code + Inference)*
- **Suggested implementation order:** (1) design + migrate `user_blocks` table, (2) build block/unblock Edge Function, (3) enforce the block server-side at the message-send Edge Function (critical path — client-side-only enforcement is not sufficient for a real safety feature), (4) client UI action + optimistic local filtering, (5) blocked-users management list (ideally inside Settings).
- **Questions for the lead developer:**
  1. Should blocking be mutual/symmetric in effect (neither party can contact the other) or one-directional (only the blocker stops seeing/being reachable by the blocked user, who is unaware)? This materially changes both UX and server-enforcement logic.
  2. Should an existing chat thread be hidden, deleted, or just frozen (read-only) on block?
  3. Should blocking also automatically decline/cancel any pending group invites between the two users?

---

## 7. Supabase Reports MVP

### Overview
- **Goal:** Backend infrastructure so admins can review user reports (task 5) — a new table, Edge Function, RLS policy, and a minimal admin-facing review surface.
- **Estimated complexity:** Medium
- **Estimated implementation time:** 2-3 days (backend-only; excludes task 5's client UI, counted separately above but should be delivered together).
- **Dependencies:** Feeds task 5 directly; can reuse the existing admin tab infrastructure (`renderAdminTab()`/`API.adminStats()`).

### Existing Project Analysis
- **Existing files to reuse:** `supabase/functions/_shared/db.ts`, `_shared/response.ts`, `_shared/ratelimit.ts` — the shared Deno utilities every existing Edge Function already builds on (confirmed present from prior inspection of `groups/index.ts`, `upload-media/index.ts`). *(Existing source code)*
- **Existing components to reuse:** `renderAdminTab()` in `app.js` and its existing card-list rendering pattern (`admin-stat-card`, `.card`/`.card-body` for lists like `admin-schools-list`/`admin-users-list`) — a "Reports" section can be added as one more list in this exact same tab, reusing `API.adminStats()`'s response-shape convention (or a sibling call) rather than inventing a new admin surface.
- **Existing services to reuse:** The `approve`/`reject` Edge Functions' pattern of `SET LOCAL "app.actor_id"` for audit-trail attribution (seen in `approval_log`'s trigger, migration 013) — the same technique should attribute report-review actions (dismiss/action-taken) to the reviewing admin.
- **Existing navigation to reuse:** The existing Admin tab (`tab-admin`, gated by `_isAdmin(currentUser)`), already role-gated via the `role` column added in migration 022.
- **Existing design tokens/styles to reuse:** `.admin-stat-card`, `.card`, `.search-empty-state` (empty-state pattern already used in `renderAdminTab()`).
- **Existing database tables/structures to reuse:** `approval_log` as the direct structural template (append-only, actor/target, RLS-participant-scoped, `service_role`-only writes); `users.role` for admin gating, already established and RLS-enforced. *(Existing source code / Supabase MCP)*

### Required Changes
- **Files requiring modification:** `app.js` (`renderAdminTab()` extended with a reports section + action buttons to dismiss/action a report), `api.js` (`API.adminStats()` extended, or a new `API.listReports()`/`API.reviewReport()`), `index.html` (new admin sub-section markup).
- **New files needed:** `supabase/functions/report-user/index.ts` (client-facing submit endpoint, shared with task 5), and either an extension of an existing admin Edge Function or a new `supabase/functions/reports-admin/index.ts` for the review actions (list/dismiss/action), following the existing one-function-per-concern convention.
- **Database changes:** New migration, e.g. `NNN_create_user_reports.sql`:
  - `user_reports(id UUID PK, reporterId UUID FK→users, targetId UUID FK→users, reason TEXT CHECK (reason IN (...)), details TEXT, status TEXT CHECK (status IN ('open','reviewed','dismissed','actioned')) DEFAULT 'open', reviewedBy UUID FK→users NULL, createdAt TIMESTAMPTZ DEFAULT now(), reviewedAt TIMESTAMPTZ NULL)`, with `CHECK (reporterId <> targetId)` mirroring `approval_log_no_self_action`.
  - RLS: reporters can `SELECT` their own submitted reports; **no** direct client `INSERT` (writes only via the `report-user` Edge Function using `service_role`, exactly like every other write-guarded table in this project); admin `SELECT`/`UPDATE` (status transitions) via a `SECURITY DEFINER` function or Edge Function using `service_role`, never direct grants to `authenticated`.
  - This structure directly mirrors the already-proven, audited `approval_log` design, minimizing the risk of repeating the `chat_groups` RLS-gap incident found in the prior audit. *(Existing source code — structural precedent; schema itself is new, marked Inference)*
- **API changes:** Two new/extended endpoints — submit report (task 5's dependency) and admin review actions.
- **Navigation changes:** None beyond extending the existing Admin tab.

### Risks
- **Architectural risk:** Low-Medium if the `approval_log` pattern is followed faithfully; High if a new, less-audited access pattern is invented instead. This is precisely the category of risk the prior security audit flagged as already having gone wrong once in this codebase.
- **UI/UX risk:** Low — purely an admin-facing addition to an existing gated tab.
- **Database risk:** As above — RLS/REVOKE correctness is the central risk; must be verified with `information_schema.table_privileges` (as was done during the prior audit for `chat_groups`) before considering this "done," not just assumed correct from the migration file.
- **App Store review risk:** Not applicable directly, but a working reports pipeline is generally a prerequisite Apple looks for (via the app's own moderation capability, not App Store Connect metadata) in UGC apps — supports the earlier point under task 5. *(Inference)*

### Recommendations
- **Suggested implementation approach:** Copy `approval_log`'s migration structure near-verbatim (table shape, RLS policy style, trigger/`SECURITY DEFINER` pattern for status changes) rather than designing a new access-control approach from scratch, since that pattern is the one component of this system that has already been through your team's own design and (implicitly) held up under RLS scrutiny in the review. *(Existing source code + Inference)*
- **Suggested implementation order:** (1) migration + RLS for `user_reports`, (2) verify grants via `information_schema.table_privileges` exactly as done in the prior audit, (3) `report-user` submit Edge Function, (4) admin review Edge Function/RPC, (5) admin tab UI section, (6) only then wire up task 5's client submit UI.
- **Questions for the lead developer:**
  1. Should reports support attachments (e.g., a screenshot of an offensive message), which would pull in `upload-media`'s existing pattern, or text-only for the MVP?
  2. What admin actions should a report support beyond dismiss (e.g., directly trigger a `reject`/ban on the target user, tie into task 6's block)?
  3. Should there be any rate limiting on report submission (e.g., via the existing `_shared/ratelimit.ts`) to prevent report-spam?

---

## 8. App Store Connect Metadata

### Overview
- **Goal:** Prepare the metadata content (name, subtitle, description, keywords, screenshots, privacy answers, age rating) needed for an App Store Connect listing.
- **Estimated complexity:** Low (as a content/documentation task) — **Unknown/Not assessable** as a technical submission task, since there is no native app target in this repository (see top-level flag).
- **Estimated implementation time:** 1-2 days for content drafting; cannot estimate submission/build work without knowing the distribution strategy.
- **Dependencies:** **Blocking dependency not yet resolved:** a decision on how this web app will be distributed via the App Store (native rewrite, Capacitor/Cordova wrapper, PWA-to-app-store tooling, or "not applicable, web-only") must come from the lead developer before this task can be scoped technically.

### Existing Project Analysis
- **Existing files to reuse:** None found — there is no `README.md` App Store section, no marketing asset folder, no existing app icon set at App Store dimensions, and no privacy-policy document referenced in the repo beyond what may exist in `landing.html`'s copy (not confirmed to be legally sufficient for a privacy nutrition label). *(Existing source code — absence confirmed)*
- **Existing components to reuse:** `landing.html`'s existing marketing copy and visual identity (`FCOM` wordmark, color tokens, tagline copy) as the source of truth for tone/voice when drafting the App Store description and subtitle, so the listing feels consistent with the existing brand. *(Existing source code)*
- **Existing services to reuse:** Not applicable.
- **Existing navigation to reuse:** Not applicable.
- **Existing design tokens/styles to reuse:** `--blue`/`--cyan` brand colors and the `FCOM` wordmark treatment from `landing.html`/`style.css` for any App Store screenshot frames/marketing graphics.
- **Existing database tables/structures to reuse:** Not applicable — but the project's actual data-handling behavior (custom JWT auth, phone/OTP verification, Supabase-hosted user data, `role`/`status` fields, image uploads via `upload-media`) is exactly what must be accurately reflected in the **App Privacy** questionnaire (data types collected: phone number, name, photos, messages; data linked to identity: yes; used for tracking: to be confirmed) — this content must be derived from the real backend behavior documented in the prior analysis, not guessed. *(Existing source code / Inference for the specific privacy-label answers, which require a compliance decision, not just a technical one)*

### Required Changes
- **Files requiring modification:** None in the app codebase itself for the metadata content; this is primarily an App Store Connect dashboard task plus possibly a new `docs/app-store-metadata.md` if the team wants it version-controlled.
- **New files needed:** App icon at required resolutions, App Store screenshots (per device size), a privacy policy URL/document (required by Apple, not currently confirmed to exist), `docs/app-store-metadata.md` (optional, for internal review/versioning of listing copy).
- **Database changes:** None.
- **API changes:** None.
- **Navigation changes:** None.

### Risks
- **Architectural risk:** **Critical/blocking** — this task cannot be meaningfully scoped until the lead developer decides on a distribution mechanism, since "App Store Connect" fundamentally requires a native binary/bundle identifier, which does not exist for this project today.
- **UI/UX risk:** If a wrapper approach (Capacitor/PWABuilder) is chosen, Apple's review guidelines (4.2 "Minimum Functionality") are historically strict about thin WebView wrappers around web content being rejected unless the app provides substantial native-feeling functionality — this is a real review risk that should be discussed early, before investing in metadata/screenshots. *(Inference, based on general knowledge of App Store review guidelines — not verified against this specific app)*
- **Database risk:** Not applicable directly, but the App Privacy questionnaire must accurately reflect the real data flows (custom JWT, phone numbers, Supabase Storage for photos) documented in the prior analysis — getting this wrong is a compliance risk, not a coding risk.
- **App Store review risk:** High uncertainty until the wrapper/native decision is made. Additionally: this app currently has an approval-gated, invite/school-based registration flow with manual admin approval — Apple reviewers need a way to test the app (demo account or bypass), which does not appear to exist today and would need to be planned for review notes.

### Recommendations
- **Suggested implementation approach:** Split this into two independently schedulable pieces: (a) **content drafting** (name, subtitle, description, keywords, privacy-label answers) — low-risk, can start now, sourced from `landing.html`'s existing copy and the backend's real data behavior; (b) **technical distribution strategy** (native vs. wrapper vs. not-applicable) — must be decided by the lead developer before any submission work is estimated or begun. *(Inference)*
- **Suggested implementation order:** (1) lead developer decides distribution strategy, (2) draft listing content/screenshots in parallel using existing brand assets, (3) prepare privacy policy document reflecting actual data handling, (4) only once a native/wrapper build exists, proceed to App Store Connect submission itself.
- **Questions for the lead developer:**
  1. What is the intended distribution mechanism — native rewrite, a wrapper (Capacitor/Cordova/PWABuilder), or is "App Store" here actually a misnomer for something else (e.g., a Google Play / web install prompt)? This is the single most important open question in this entire plan.
  2. Does a privacy policy document already exist outside this repository?
  3. How will Apple reviewers get past the manual, admin-approval-gated registration flow to actually test the app (demo/test account, or a review bypass)?

---

## Cross-cutting observations

- **Modal/overlay component:** Tasks 5 and 6 both need some form of confirmation/selection UI beyond native `alert()`/`confirm()`. Recommend designing **one** shared minimal modal component and reusing it for both, rather than building two bespoke UIs — this keeps the "prefer reusing existing code/patterns" principle intact even for new UI primitives.
- **RLS discipline:** Tasks 6 and 7 both introduce new tables. The prior security audit found a real, live RLS gap in this project's most recently shipped tables (`chat_groups`/`group_members`/`group_invites`). Both new tables should be built by directly copying `approval_log`'s proven RLS/REVOKE structure and verified against `information_schema.table_privileges`, not just trusted from the migration file's intent.
- **Figma:** No project design file was found in the repository, and I did not guess a file key to query via the Figma MCP. If mockups exist for any of these 8 screens, please share the Figma URL so `get_design_context` can pull exact specs instead of the CSS-pattern-based inference used throughout this plan.
- **Terminology overlap:** "Moderation" is used in this task list for what the existing code calls **account approval** (task 4), while tasks 5-7 introduce a genuinely new concept of **content/user reporting**. Recommend the team align on distinct terms internally to avoid confusion during implementation and QA.

The flex layout with wrapping means a fifth tab would either wrap to a new row or compress awkwardly on mobile, so embedding settings within the Profile tab makes more sense than adding another bottom-nav item. I've got enough context from the codebase, database patterns, Lottie animations, and design files to put together a solid implementation now.