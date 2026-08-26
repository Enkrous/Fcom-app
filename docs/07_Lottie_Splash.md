# Fcom — Technical Review + Lottie Splash Animation Proposal

*No files modified, no commits, no branches, no deployment, no Lottie asset generated. This is a review + proposal for the lead developer.*

---

# PART 1 — TECHNICAL REVIEW

Re-verified against the current live codebase and the live Supabase project before writing this review (not from memory of the prior conversation alone). Two completed implementation proposals exist so far: **Settings Screen** and **Report User / Block User / Supabase Reports MVP**. Both are reviewed below.

## 1.1 Settings Screen proposal

**What is correct**
- Reuses the existing `screens` object + `showScreen()` navigation mechanism — no new routing concept introduced.
- New screen correctly follows the `.screen`/`.screen-shell`/`.pane-shell` structural convention (verified against `index.html`'s other screens).
- `credo_settings` follows the exact same local-storage-key convention as every other `credo_*` key (`loadJSON`/`saveJSON`, listed in the header doc comment, cleared in `resetAll()`).
- Correctly scoped as **local-only, per-device** (no backend sync) — a reasonable, low-risk choice for a first notification-preference toggle, and it does not touch `api.js`'s monkey-patch layer at all, so it carries zero risk to the sync engine.
- `Notif.checkAndNotify()` gating on `Credo.getNotificationsEnabled(user.id)` is a minimal, single-line integration into existing code rather than a new abstraction.

**Potential issues (fact, re-verified just now)**
- **Duplicate logout control.** The proposal adds `#settings-logout-btn` wired to `handleDemoLogout()`. But `handleDemoLogout()` is already bound to `#demo-logout-btn` inside `#demo-bar` (`index.html:39`), which is **not a hidden dev tool** — `showScreen()` and `route()` unhide it for *every* logged-in user (`demoBar.classList.remove('hidden')` whenever `_appVisible && currentUser`, `app.js:181-189`). So after this change there would be two independent logout buttons visible in overlapping contexts (top bar, always; Settings screen, when open), both calling the same function. This isn't broken, but it's a real, avoidable duplication the earlier proposal didn't flag.
- The Settings screen's "Назад" (`closeSettings()`) hardcodes a return to `showScreen('main') → showTab('profile')` rather than reusing the generalized `returnState` pattern already established by `openUserProfile`/`closeUserProfile` (`_profileReturnState`). This is **not actually a defect** — Settings currently has exactly one entry point, so the simpler hardcoded return is the right amount of abstraction, not less — but it's worth the lead developer explicitly confirming Settings will never be opened from anywhere else (e.g. a future "notifications" deep link), since adding a second entry point later would require retrofitting the `returnState` pattern.

**Risks**
- Low. The riskiest part (a new persistent top-level screen) reuses 100% existing CSS/JS patterns.

**Suggested improvements**
- Remove `#settings-logout-btn` from the Settings screen, or — if the lead developer wants Settings to be the single canonical place for account actions — consider hiding `#demo-logout-btn` when Settings exists as a screen, rather than having both simultaneously. This is a product decision, not something to decide unilaterally.

**Questions for the lead developer**
- Should the top-bar `#demo-logout-btn`/`#demo-reset-btn` eventually move *into* the Settings screen entirely (bigger, more sensitive change), or should Settings simply not duplicate them (smaller, safer change)?

## 1.2 Report User / Block User / Supabase Reports MVP proposal

**What is correct**
- New tables (`reports`, `user_blocks`) use the same column-naming convention as every existing table (camelCase in double quotes: `"reporterId"`, `"targetId"`, `"createdAt"`) — verified against the live `list_tables` output for `users`/`messages`/`approval_log`.
- Chose the **strictest existing security pattern** (RLS enabled, zero policies, zero grants — matching `otp_codes`/`sessions`/`device_blocks`/`rate_limit_log`) rather than either of the two weaker patterns already live (`users`/`messages`'s inert-`auth.uid()` RLS, or `chat_groups`'s fully-open grants). Re-checked this against the live grant/policy state again just now — still accurate.
- `reports/index.ts` and `blocks/index.ts` correctly mirror `groups/index.ts`'s single-function, `action`-routed shape rather than inventing a new Edge Function convention.
- Duplicate-report prevention correctly mirrors the existing two-layer pattern from `rate/index.ts` (app-level fast check + DB-level partial unique index as the atomic guard), rather than inventing a new abstraction.
- Correctly identified `device_blocks` (device-fingerprint ban after rejection) as unrelated to user-to-user blocking, avoiding a name-collision-driven false reuse.

**Potential issues**
- The proposed `messages/index.ts` block check was specified narratively ("after loading partner, before the messages query") rather than pinned to an exact line/ordering relative to the existing `cross_school_forbidden`/`partner_not_approved` checks. Low severity, but should be nailed down to one exact ordering before implementation so error-response precedence is deterministic (e.g., should a blocked-but-cross-school request return `blocked` or `cross_school_forbidden` first?).
- `blocks/index.ts` intentionally has no IP rate limit (unlike `reports/index.ts`'s 5/hour). This was a deliberate, reasoned choice in the proposal (blocking has low spam value), not an oversight — flagged here for the lead developer to explicitly sign off on rather than have it be an implicit, unreviewed asymmetry.

**Risks**
- Low for the schema/functions themselves. The main residual risk is scope-related: block enforcement was deliberately limited to direct messages, not group chats — already called out as an open question in that proposal.

**Suggested improvements**
- None beyond what that proposal's own §8 already lists — re-reviewing it now, it already surfaces the right open questions (school scope, group-chat enforcement, admin UI absence) rather than silently deciding them.

**Questions for the lead developer**
- Already listed in that proposal's §8 — no new ones identified on re-review.

## 1.3 Cross-cutting architecture check

- **Coding conventions**: both proposals consistently use the project's `ok()`/`err()` response helpers, `requireAuthWithRevocation`, `getServiceClient()`, and never bypass the custom-JWT auth layer. Confirmed by re-reading `_shared/response.ts`, `_shared/jwt.ts`, `_shared/db.ts` again.
- **No unnecessary abstractions**: neither proposal introduces a repository layer, a state-management library, or any build tooling — both stay inside the existing "flat files + Edge Functions" shape.
- **RLS**: both proposals correctly avoid replicating the one confirmed-still-live critical gap in the project (`chat_groups`/`group_members`/`group_invites` — RLS disabled, full anon/authenticated grants, re-confirmed live via the Supabase MCP advisor during that session). Neither proposal touches those three tables.
- **Fact vs. assumption**: the one new fact surfaced in this review pass (§1.1, duplicate logout) was found by grepping the live `index.html`/`app.js` just now, not recalled from memory — it was not caught during the original Settings Screen proposal.

---

# PART 2 — LOTTIE SPLASH ANIMATION

## Pre-work performed

- **Figma**: checked for a linked file. Confirmed (again, independently) that **no Figma file key exists anywhere in this repository**, and the connected Figma account has no project file identifiable from the codebase — this matches the original project analysis's own conclusion. Figma **cannot** serve as source of truth here; this proposal is instead grounded in the app's actual existing branding assets (below). This is stated as fact, not assumption — it was verified by searching the repo for `figma.com`/file-key references and finding none.
- **Context7**: queried official `lottie-web` (`/airbnb/lottie-web`) documentation for `loadAnimation` options, event lifecycle (`complete`, `loopComplete`, `DOMLoaded`, `destroy`), and the vanilla-script integration model.
- **Existing launch flow**: traced precisely (see §Technical Integration).
- **Existing branding**: there is **no logo image file** anywhere in the repo (`Glob` for `*.png/*.svg/*.ico` returned nothing at the project root). The only brand mark that exists is a CSS-styled `<div class="brand-mark">F</div>` inside `landing.html`'s own inline stylesheet.
- **Existing animation infrastructure**: `style.css` already defines an **unused** `.loader`/`.loader-stack` component (full-screen blurred overlay, radial gradient, `@keyframes loading` shimmer bar, `.is-hidden` with a 700ms opacity/visibility transition) — confirmed via grep that this CSS exists but has **zero matching markup in `index.html` and zero references in `app.js`**. It is dead/dormant code, apparently built for exactly this kind of full-screen loading moment but never wired up. Also present: `@keyframes screen-in` (used by every `.screen` on show) and `@keyframes message-in` — both short (≤240ms), `cubic-bezier`-eased, opacity+transform fades — the established motion language of the app.
- **Design tokens**: `:root` in `style.css` defines the full color/radius/shadow/font token set (`--blue`, `--cyan`, `--violet`, `--gold`, `--bg: #050507`, `--font-display: "Clash Display"...`) — these should drive any Lottie composition's color palette and the splash screen's background/typography if a wordmark accompanies the animation.

## Overview

**Goal**: Show a brief, branded Lottie animation at app launch, before the user reaches the landing page or the dashboard, to give the product a moment of polish and identity beyond the current plain "F" letter mark.

**User experience**: A full-screen, centered animation plays once (or a small fixed number of loops) for a short, fixed duration, then transitions — via the existing fade/opacity language, not a new effect — into whatever the launch flow would have shown next (the marketing landing page for a fresh visit, or straight into the dashboard/login when arriving via `?open=dashboard`). The splash must never block the user longer than its own fixed duration, and must degrade silently (skip straight to normal launch) if the animation asset fails to load.

**Integration strategy**: Insert the splash as a new, temporary full-screen overlay that sits **on top of** the existing `#landing-shell`/`#app-shell` structure during the first ~1.5–2 seconds of `init()`, then removes itself and lets the existing `route()`/`openDashboardExperience()` logic proceed completely unchanged. No existing screen, route function, or state-management code is modified — the splash is purely an additive, self-removing layer, deliberately reusing the dormant `.loader` overlay pattern rather than inventing a new one.

## Existing Project Reuse

**Existing launch flow (traced precisely, fact):**
1. Browser requests `index.html` (no build step — confirmed no `package.json`, plain `<script src="...">` tags for `avatars.js`, `presence.js`, `notifications.js`, `credo.js`, `api.js`, `app.js`, in that fixed order).
2. `DOMContentLoaded` fires `init()` (`app.js:2110`, `app.js:1947`).
3. `init()` calls `setAppVisible(false)` first thing — `#app-shell` stays `hidden`, `#landing-shell` (the `landing.html` iframe) is shown.
4. Near the end of `init()`, it reads `?open=dashboard` from `window.location.search`. If present (i.e. the user clicked a CTA in `landing.html`, which does a **full top-level navigation** via `<a href="index.html?open=dashboard" target="_top">`, not a postMessage — confirmed by grep, there is no `postMessage` anywhere in `landing.html`), it calls `openDashboardExperience()`, which calls `setAppVisible(true)` and routes into login/register/main via the existing `route()` logic.
5. Otherwise, the landing page simply remains visible — this is the default "cold" entry point for most visitors.

There is currently **no loading/splash moment at all** — whichever screen applies appears as soon as parsing completes.

**Existing components reused:**
- The dormant `.loader`/`.loader-stack`/`.is-hidden` CSS block (full-screen overlay + blur + fade) — reused as the shell for the splash, replacing its currently-empty content with the Lottie canvas.
- `setAppVisible()` (`app.js:114`) — the splash overlay is toggled independently of this function (it sits above both `#landing-shell` and `#app-shell`), so this function needs zero changes.
- Existing design tokens (`--bg`, `--blue`, `--violet`, `--cyan`, `--font-display`) — reused for the overlay background and any accompanying wordmark, consistent with the rest of the app rather than a bespoke splash palette.
- Existing fade/opacity motion language (`180–700ms ease` transitions, `screen-in`/`message-in` keyframe conventions) — reused for the splash's own fade-out, rather than introducing a new easing curve or duration convention.

**Existing assets:** none usable as-is — there is no logo file, no existing Lottie/animation asset, and (per the pre-work above) no Figma file to source one from. **New assets are required** (out of scope to create per this task's explicit restriction — see Required Changes).

**Existing animation infrastructure:** none beyond CSS keyframes/transitions (no JS animation library, no `requestAnimationFrame` usage found anywhere in `app.js`). `lottie-web` would be the **first JS animation dependency** introduced into the frontend.

## Required Changes

**Files that would require modification:**
- `index.html` — add the splash overlay markup (reusing `.loader`/`.loader-stack` classes) as the very first element inside `<body>`, before `#landing-shell`; add one new `<script>` tag for the vendored Lottie player, loaded *before* `app.js` (since `app.js`'s `init()` will trigger the splash).
- `app.js` — `init()` gains a small splash-orchestration step (show splash → play → on `complete` event or hard timeout → hide splash → proceed with the existing `setAppVisible(false)`/`?open=dashboard` logic exactly as today).
- `style.css` — extend the existing (currently unused) `.loader` rules minimally (e.g. sizing the Lottie container), no new token system needed.

**New assets (not created by this proposal, per the explicit restriction):**
- One Lottie JSON export (e.g. `assets/splash.json`) — to be produced separately in After Effects/Bodymovin or via a design tool, sized appropriately (small file, ideally < 100–150 KB given this is an otherwise near-zero-payload static site).
- The `lottie-web` player library, **vendored locally** (e.g. `lottie.min.js` at the repo root, alongside the other flat `.js` files) rather than pulled from a CDN — this is the only choice consistent with the project's confirmed convention of zero external runtime script dependencies (verified: every `<script src>` in `index.html` today points to a local file, none to a CDN).

**New files (if required):**
- Optionally, a small dedicated `splash.js` (rather than growing `app.js` further) containing just the show/hide/timeout orchestration, exported as a tiny global object — matching the project's existing convention of one small focused file per concern (`avatars.js`, `presence.js`, `notifications.js` are all this size/shape). This is a judgment call for the lead developer (see Questions) — folding it directly into `init()` in `app.js` is also consistent with the codebase's general tendency to centralize UI orchestration there.

## Animation Specification

- **Animation duration**: recommend the Lottie composition itself run **1.0–1.5 seconds**, since this is a *branding beat*, not a loading mask (there is no slow asset fetch to hide — the whole app is a handful of small static files).
- **Playback behavior**: `autoplay: true`, single pass by default.
- **Loop behavior**: `loop: false` (play once) as the default recommendation — a splash that loops indefinitely risks feeling like a stuck/frozen app on a fast connection where nothing is actually being awaited. If the lead developer wants a subtle looping idle state as a safety margin (e.g. in case initial script parse is slow on a low-end device), `loop: true` combined with a **hard max-visible timeout** (see below) is the safer variant.
- **Completion behavior**: on the `complete` event (fired once per `lottie-web`'s documented lifecycle) *or* a hard timeout — whichever comes first — trigger the fade-out. A hard timeout (e.g. 2.5s ceiling) is required regardless of the animation's own duration, so a malformed JSON, a slow network fetch of `splash.json`, or a JS error never leaves the user staring at a frozen splash — this directly reuses the "fail open" philosophy already used elsewhere in the backend (e.g. `rateLimitDb`'s fail-open comment), applied here to the client.
- **Transition to next screen**: fade the overlay's `opacity` to 0 over the existing `.loader`'s already-defined `700ms ease` transition, then set `display: none`/remove the node, then continue exactly into the existing `setAppVisible(...)` / `?open=dashboard` branch — the splash never decides *what* comes next, it only delays *when* the existing logic runs.
- **Performance considerations**: use the **SVG renderer** (the `lottie-web` default) for a small, simple branding animation — canvas rendering is unnecessary for this scale and SVG keeps the animation crisp on high-DPI screens. Load the Lottie JSON via `path` (a separate small fetch) rather than inlining it as `animationData` directly in `index.html`, to keep the initial HTML payload small and cacheable separately from markup. `lottie.min.js` itself (typically ~60–100 KB) is the only meaningfully new payload added to what is currently a very lightweight page — worth flagging explicitly to the lead developer as the main cost of this feature (see Risks).

## Technical Integration

The splash is implemented as a **transient, self-removing overlay layer**, not a new screen in the `screens` object and not a new route state — this is a deliberate architectural choice to keep it fully decoupled from `route()`/`showScreen()`/`_currentScreen`, none of which need to know the splash ever existed.

```
DOMContentLoaded
  → init()
      1. show #app-splash overlay (reusing .loader/.loader-stack CSS)
      2. lottie.loadAnimation({ container: splashEl, renderer: 'svg', loop: false, autoplay: true, path: 'assets/splash.json' })
      3. on 'complete' (or after a hard ~2.5s timeout, whichever first):
           - fade out #app-splash (existing .loader .is-hidden transition)
           - animationInstance.destroy()  // per lottie-web's documented cleanup API
           - remove #app-splash from the DOM
      4. proceed with the EXISTING init() body unchanged:
           setAppVisible(false); ...wire up all the existing event listeners...; route-on-?open=dashboard check
```

This ordering matters: steps 3–4 must fully complete (or the timeout must fire) **before** `setAppVisible`/the query-param check run, so the splash always shows first regardless of whether the destination ends up being the landing page or the dashboard — but the wiring of all the *other* event listeners in `init()` should not be blocked on the animation, only the *visibility* handoff should be. In practice this means the splash's show/hide logic wraps around the existing `setAppVisible(false)` call and the `?open=dashboard` branch specifically, not the entire `init()` function.

## Risks

**UX risks**
- A splash that's too long or loops indefinitely on a genuinely instant-loading static site can feel like an artificial, unnecessary delay rather than polish — mitigated by the short fixed duration + hard timeout above.
- If the eventual destination is the dashboard directly (returning user, `?open=dashboard`) vs. the landing page (new visitor), showing the *same* splash for both may feel redundant for returning users who already saw it once this session/browser — worth deciding whether to show it only once per browser session (e.g. a `sessionStorage` flag) or every load (see Questions).

**Performance risks**
- `lottie-web` adds a real, measurable payload (tens of KB) to what is currently an extremely lightweight page load — the first meaningfully "heavy" dependency in the whole frontend. This is the single biggest cost/benefit tradeoff in this proposal and should be explicitly signed off on, not just implemented.
- A hard timeout is mandatory (not optional) precisely because this is a static site with no build step / no bundler validation — a malformed or missing `splash.json` would otherwise be caught silently in production with no error boundary.

**Integration risks**
- Low — the design deliberately avoids touching `route()`, `showScreen()`, the `screens` map, or any state-management/sync code. The only shared surface is `init()`'s top few lines and the previously-dead `.loader` CSS block, which had zero other consumers to conflict with.
- This is the first JS *library* dependency (as opposed to first-party small files) the frontend has ever had — worth the lead developer confirming this precedent is acceptable before it's set, since it opens the door to "just add a library" reasoning for future features that this project has so far deliberately avoided (zero `package.json`, zero bundler, zero third-party runtime scripts today).

## Questions For The Lead Developer

1. **Vendoring vs. CDN**: this proposal recommends self-hosting `lottie.min.js` locally to match the project's zero-external-script convention. Is a CDN (e.g. jsdelivr/unpkg) acceptable instead, given it would be the first external network dependency this frontend has ever had?
2. **Show-once vs. show-every-load**: should the splash play on every page load, or only once per browser (via a `sessionStorage`/`localStorage` flag), especially for users landing directly on `?open=dashboard`?
3. **Where does the animation asset come from?** Since no Figma file exists for this project and no logo asset exists today, who owns producing the actual `.json` export (After Effects/Bodymovin, a design tool, or a commissioned/stock Lottie), and on what visual concept (the existing "F" brand-mark animated, or something new)?
4. **New file vs. inline in `app.js`**: should the splash orchestration live in a new small `splash.js` (matching the size/shape of `avatars.js`/`presence.js`/`notifications.js`), or be folded directly into `init()` in `app.js`?
5. **Loop vs. single-play**: confirm single-play (recommended) vs. a looping idle state bounded by a hard timeout.
6. **Reviving `.loader`**: this audit found the `.loader`/`.loader-stack` CSS is currently fully dead code (defined, never used). Should this proposal be the one to finally wire it up, or was it deliberately abandoned for a reason not visible in the code (e.g. a past experiment that was intentionally rolled back)?