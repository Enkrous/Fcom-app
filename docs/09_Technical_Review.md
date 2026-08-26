# Complete Technical Review — All Proposals (Consolidated)

Scope reviewed: Project Analysis, Implementation Plan, Settings Screen, Report User Flow + Block User Flow + Supabase Reports MVP, Lottie Splash Animation, Onboarding Flow, Waiting for Moderation Screen, App Store Connect Submission Package.

Before scoring anything, I re-verified several cross-cutting claims directly against the live source rather than trusting my own prior summaries, since the whole point of this pass is to catch things that looked fine in isolation but weren't checked *together*. Findings below are grounded in that re-verification (cited inline) plus the accumulated proposal content from this engagement.

---

## 1. Executive Summary

**Overall quality score: 7.5 / 10**

Each individual proposal is well-reasoned, reuse-first, and respects the "don't redesign" constraint. The security posture chosen for the new `reports`/`user_blocks` tables is genuinely good — better than the existing (still-broken) `chat_groups` pattern. However, the proposals were authored **sequentially and independently**, each against the *original* production baseline, not against each other. That produces a specific, fixable class of problem: several proposals touch the exact same functions (`route()`, `init()`, `resetAll()`, the `screens` map) with isolated diffs that were never reconciled against one another. None of these are deep architectural conflicts — they're integration/merge-order issues — but if handed to a junior engineer as 8 separate patches applied literally, at least one (`resetAll()`) would silently break.

**Overall readiness for implementation: ~55%.**
Not because the designs are wrong, but because: (a) three proposals need to be manually reconciled into single combined diffs before anyone starts coding, (b) one already-known **critical, live security vulnerability** (`chat_groups`/`group_members`/`group_invites` RLS) remains completely unaddressed by all 8 proposals and will still be exploitable in production after these ship, and (c) the App Store package correctly identifies that submission is currently blocked on multiple hard requirements (no native binary, no Privacy Policy, no account deletion) that no other proposal in this batch addresses — including the Settings Screen, which was the natural home for account deletion and wasn't asked to include it.

## 2. Architecture Review

**Strengths**
- Every proposal correctly identified and reused the existing `route()` → `showScreen()` state machine instead of inventing a parallel navigation mechanism.
- Every proposal reused existing design tokens (`.glass-panel`, `.btn-outline`, `.hint`, `--blue`/`--cyan`/`--gold`) with zero new colors or fonts introduced across all six feature proposals.
- The Reports/Blocks migration explicitly designed itself as the *opposite* of the known-vulnerable `chat_groups` pattern (RLS enabled, zero grants, service_role-only via Edge Functions) — this is self-aware, architecture-consistent design, not just copy-pasted convention.
- The "localStorage-first, server-shadow" pattern (`credo.js` writes, `api.js` shadow-syncs) was respected by every proposal that touches data — none of them bypass it with a parallel fetch/state mechanism.
- Waiting-for-Moderation correctly discovered and reused dormant existing infrastructure (`SYNC_EVENT`/`handleServerSync`) instead of building a second polling loop — this is the single best piece of reuse discipline across the whole batch.

**Weaknesses**
- No proposal treats `app.js` as an increasingly critical bottleneck: Settings, Onboarding, Waiting-for-Moderation, and Splash **all** add event-wiring lines inside the same `init()` function, and **three** proposals (Settings, Report/Block, Onboarding) each independently modify `credo.js`'s `resetAll()` (verified live at `credo.js:543-553`, currently 9 `removeItem` lines). None of the proposals reference each other's edits, so applying them "as written" in sequence will not compose correctly — see §3 for the concrete break.
- The project has no test coverage or CI (confirmed in the original analysis), so none of these behavioral changes (auto-transition, block-gated messaging, onboarding gating) have any regression safety net beyond manual testing.
- `app.js` remains a single ~2,100+ line module; six proposals collectively add non-trivial logic to it with no proposal suggesting even lightweight internal organization (e.g., grouping related functions), which is consistent with "don't redesign" but does compound the existing maintainability debt noted in the original analysis.

**Recommendations**
- Before implementation, produce **one consolidated diff per touched file** (`credo.js`, `api.js`, `app.js`, `index.html`, `style.css`) rather than applying each proposal's snippet independently. This is a 30-60 minute reconciliation task, not a redesign.
- Treat `init()`'s growing wiring list and `resetAll()`'s growing removal list as a signal to extract a single `NEW_LOCALSTORAGE_KEYS` array or similar tiny helper — a genuinely minimal, non-architectural change that removes the recurring merge-conflict class permanently. Flagging as a suggestion, not a requirement, per "don't redesign."

## 3. Cross-Feature Consistency

This is where independent review of each proposal in isolation would have missed real issues. Found by diffing intent against the *same* baseline functions:

| # | Conflict / interaction | Severity | Detail |
|---|---|---|---|
| 1 | **`resetAll()` triple-edit** | High (mechanical, not logical) | Settings (`credo_settings`), Report/Block (`credo_user_blocks`), and Onboarding (`credo_onboarding_seen`) each propose adding one line to the exact same function, independently, against the current 9-line baseline (verified at `credo.js:543-553`). Applied as three sequential "replace this function" patches, the second and third would each be working from a stale copy and could silently drop an earlier addition. **Must be merged into one 12-line `resetAll()` by hand.** |
| 2 | **`init()` quadruple-edit** | Medium (mechanical) | Settings, Onboarding, Waiting-for-Moderation, and Splash all add wiring statements inside `init()`. Individually harmless (all are additive `addEventListener` calls on different, non-overlapping selectors), but must be combined into one pass over `init()` rather than four separate patch applications. |
| 3 | **Naming collision risk: `credo_blocked` vs. `credo_user_blocks`** | Medium | `credo_blocked` **already exists** in production (`credo.js:551`) and backs `isDeviceBlocked()`/`blockDevice()` — the *device-level* anti-abuse block used after a rejected registration. The Report/Block proposal's new `credo_user_blocks` key (peer-to-peer blocking) is a different concept with a dangerously similar name. No code collision exists (different keys), but this is a real readability/maintainability trap for whoever implements or later debugs this — recommend the lead confirm the naming before implementation, e.g. rename the new key to something more distinct (`credo_peer_blocks`) if there's still time to change the proposal. |
| 4 | **Onboarding forces existing users through a first-run flow** | **High / product risk** | `route()`'s onboarding check (`!Credo.hasSeenOnboarding(user.id)`) has no backfill for users who registered *before* this ships. Every existing approved production user's `credo_onboarding_seen` flag is unset by default, so on their very next login after deployment, **every current user — not just new registrants — will be interrupted by the onboarding flow.** This was not addressed in the Onboarding proposal and is a genuine product/UX regression risk, not just an edge case. |
| 5 | **`handleServerSync()` will re-run `route()` every ~2s while a user sits on the new Onboarding screen** | Medium | The existing sync loop (`api.js` `syncNow`/`startLiveSync`, `SYNC_EVENT` → `handleServerSync`) runs continuously for any logged-in, approved user — which includes a user currently looking at the (new) onboarding screen. `handleServerSync()`'s existing logic only special-cases `_currentScreen === 'chat'` and `'main'`; anything else (including the new `'onboarding'`) falls through to a plain `route()` call every sync tick. The Onboarding proposal did not analyze this interaction. Whether this causes a visible flicker/step-reset depends on exactly how `route()`'s new onboarding branch was implemented (whether it re-renders `_onboardingStep` from scratch or just calls `showScreen('onboarding')` and leaves the existing DOM alone) — **this needs to be explicitly verified during implementation, not assumed safe.** |
| 6 | **Splash overlay vs. sync-event listener timing** | Low | `api.js`'s own `_init()` (registered on `DOMContentLoaded` before `app.js`'s) starts `syncNow()`/`startLiveSync()` independently of whatever `app.js`'s `init()` is doing — including if `init()` is now gated behind the splash animation completing. If the very first sync tick resolves and fires `SYNC_EVENT` before `app.js`'s `init()` has attached the `handleServerSync` listener (because it's still waiting on the splash to finish), that one event is silently dropped. Low impact in practice (the next 2s tick reconciles state), but worth confirming the splash orchestration doesn't delay event-listener registration, only the *visual* reveal. |
| 7 | **Blocking scope gap: 1:1 only, not groups** | Medium | The proposed `isBlockedEitherWay(supabase, userA, userB)` helper and the `messages/index.ts` integration point only make sense for 1:1 (`toId`-based) messages. Group messaging (`groupId`-based) has no equivalent block enforcement proposed anywhere. A blocked user and their blocker can still co-exist in the same group chat and see each other's messages there. Not addressed in the Report/Block proposal — needs an explicit lead decision on whether this is acceptable for MVP. |
| 8 | **App Store package correctly predicts a gap none of the other 7 proposals close** | Consistency confirmed, not a conflict | The App Store proposal flags Report/Block as "not implemented, proposal only" and flags missing account deletion as a hard blocker. Cross-checking against the Settings Screen proposal (the natural home for account management) confirms this: **Settings, as proposed, does not include an account/data deletion action.** This is internally consistent (App Store package is accurate) but represents a real, unaddressed cross-proposal gap. |
| 9 | **Report flow requires a UI pattern that doesn't exist yet** | Low/Medium | Reason selection (`spam` / `harassment` / `inappropriate_content` / `fake_profile` / `other`) cannot be captured by the project's existing `alert()`/`confirm()`-only interaction vocabulary. The Report/Block proposal implicitly requires the project's *first* non-trivial custom selection UI. This is a legitimate, small "new pattern" introduction (not a violation of "don't introduce new patterns," since none suffices) but should be called out explicitly to the lead rather than discovered mid-implementation. |

**No conflicts found** between: Splash and Waiting-for-Moderation (fully disjoint DOM/logic); Settings and Report/Block (disjoint feature surfaces, no shared state); Onboarding and Settings (disjoint); App Store metadata and any UI proposal (metadata doesn't constrain code).

## 4. Technical Risks

**Critical**
- **`chat_groups` / `group_members` / `group_invites` have RLS effectively disabled with full `anon`/`authenticated` privileges** — re-confirmed this session: the migration that creates them (`supabase/migrations/20260517153000_024_groups_and_media.sql`) contains **zero** `ENABLE ROW LEVEL SECURITY`, `GRANT`, or `REVOKE` statements (verified by direct search of the file). This is the same critical vulnerability identified in the original project audit. **None of the 8 proposals in this engagement touch or remediate it.** It will still be live and exploitable after every feature above ships. This deserves its own dedicated fix, independent of and prior to any of the 8 features reviewed here.

**High**
- Onboarding backfill gap (§3.4) — will visibly regress the experience for every existing user on next login if shipped as designed.
- Missing account deletion (App Store hard blocker, §3.8) — no proposal in this batch implements it, including Settings where it belongs.
- Missing Privacy Policy / Terms of Service — confirmed still just dead `#0` anchors in `landing.html`; blocks App Store Connect configuration entirely, independent of code quality.

**Medium**
- Three-way `resetAll()` merge risk (§3.1) and four-way `init()` merge risk (§3.2) — mechanical but real; will cause silent regressions (a "reset" that doesn't clear one of the three new keys) if patches are applied naively.
- `handleServerSync()` × Onboarding interaction unverified (§3.5).
- Group-chat blocking gap (§3.7).
- `refreshBlockedUsers()` added to the existing 2-second `syncNow()` hot path adds one more network round-trip *per active user, every 2 seconds*, on top of the already-existing `/me`, `/users`, per-partner `/messages`, and `/groups` calls. This compounds a pre-existing scalability characteristic of the polling architecture rather than introducing a new one, but it's a real, measurable addition at scale.

**Low**
- `credo_blocked` vs. `credo_user_blocks` naming ambiguity (§3.3).
- Splash/sync-listener timing edge case (§3.6) — self-healing within one poll interval.
- Report flow's need for a small new selection-UI pattern (§3.9) — solvable, just needs explicit sign-off.

## 5. Security Review

**Authentication:** Unaffected by any of the 6 feature proposals — all correctly built on top of the existing custom HS256 JWT / reg-token / session-token model without attempting to introduce parallel auth. Report/Block and Reports Edge Functions correctly reuse `requireAuthWithRevocation` exactly as every other Edge Function does.

**Authorization:** Report/Block Edge Functions correctly gate on `caller.status === 'approved'` before allowing report/block actions, mirroring the pattern used by `messages`, `groups`, etc. The `reports` admin-review endpoint correctly gates on `caller.role === 'admin'`, matching the `approve`/`reject` pattern. No privilege-escalation paths identified in the proposed code.

**RLS:** The new `reports`/`user_blocks` tables are designed correctly (RLS enabled, zero grants to `anon`/`authenticated`, service_role-only access via Edge Functions) — this is the *right* pattern, and it stands in direct, deliberate contrast to the still-broken `chat_groups` family. This inconsistency is not the new proposal's fault — it's a pre-existing wound that remains open. It should be fixed under its own migration, ideally before or alongside the Reports/Blocks migration ships, since both touch RLS posture and reviewing them together would be efficient.

**User privacy:** Settings' local-only notification toggle introduces no new data collection. Report/Block introduces `details` free-text (capped at 1000 chars) tied to `reporterId`/`targetId` — appropriately private (service_role-only). No proposal introduces any new PII collection beyond what the App Store review already catalogued (name, phone, school, grade, device fingerprint).

**Data protection:** Reports table correctly has no RLS policies granting user-level read access — even the reporter can't read their own report back via direct table access, only through the Edge Function, which is appropriately conservative.

**Abuse prevention:** Good, specific mechanisms proposed: `reports_one_pending_per_pair` partial unique index prevents duplicate open reports (DB-level, not just app-level check — correct defense-in-depth); `rateLimitDb(supabase, ip, 'reports', 5, 60*60_000)` caps report creation at 5/hour/IP; `user_blocks_unique` constraint prevents duplicate blocks; self-block/self-report both explicitly rejected at the DB constraint level (`CHECK ("blockerId" <> "blockedId")`, `CHECK ("reporterId" <> "targetId")`) — this is genuinely solid, matches the project's existing "fast check + DB constraint" convention (cited correctly against the rating-cooldown precedent in `rate/index.ts`).

## 6. Performance Review

**Potential bottlenecks:** The recurring 2-second sync loop is the dominant cost center in this architecture and pre-dates all 8 proposals; Report/Block's `refreshBlockedUsers()` addition to that loop is the only proposal that measurably adds to it. Not disqualifying, but worth a lead decision: does it need to run every tick, or only on login + when `/me` reports a change (mirroring how the heavier `_syncFromServer`/`_syncGroupsFromServer` calls are already gated behind `meResult.user.status === 'approved'` rather than running unconditionally)?

**Memory concerns:** None identified beyond what already exists — no proposal introduces unbounded client-side caches or listeners that aren't cleaned up (Onboarding's `_onboardingStep`, Waiting-for-Moderation's `_pendingCheckInFlight` are both simple, bounded, single-value state).

**Networking concerns:** Splash's `lottie.min.js` (a third-party script load) is the only new network dependency introduced across all 6 proposals; the original proposal already accounted for a hard timeout fallback if the CDN/library fails or is slow, which is the correct mitigation — confirm this was preserved as a *hard* (not best-effort) timeout in the final implementation.

**Scalability:** Fundamentally unchanged by any of these proposals — the app remains a polling-based (not push/Realtime-based) architecture, a known pre-existing characteristic, not something introduced here. Each new feature is a marginal, not structural, addition to that model.

## 7. Maintainability Review

**Code organization:** All 6 proposals correctly extend the existing single-module (`app.js`) / single-engine (`credo.js`, `api.js`) structure rather than introducing new module boundaries — consistent with "don't redesign," but see §2 weaknesses on the compounding size of `app.js`.

**Reuse:** Very high across the board — this was the standout strength of every proposal reviewed. No proposal introduced a component, service, or pattern that duplicates something that already existed.

**Future growth:** The Reports/Blocks migration's explicit commentary contrasting itself with the vulnerable `chat_groups` pattern is a good precedent — it effectively documents "here's the secure way to add a table in this project" for whoever builds the next feature. Recommend this convention be made explicit (e.g., a short paragraph in `BACKEND.md`) so it isn't only implicit in one migration's comments.

**Technical debt:** This batch of proposals does not add material new technical debt on its own — the debt it exposes (§3.1, §3.2 merge risk; `app.js` size; no tests) is pre-existing and compounding, not newly introduced.

## 8. App Store Readiness

| Item | Status |
|---|---|
| Native iOS binary / wrapper strategy | ❌ Missing — no Xcode project, no wrapper technology decided anywhere in the repo |
| Privacy Policy (live URL) | ❌ Missing — dead `#0` placeholder only |
| Terms of Service | ❌ Missing |
| Account deletion (in-app) | ❌ Missing — not present in codebase, not included in Settings proposal either |
| Community Guidelines | ❌ Missing |
| Report content mechanism | ⚠ Proposed, not implemented |
| Block user mechanism | ⚠ Proposed, not implemented |
| Content-level moderation (profanity/image filtering) | ❌ Missing — only account-level (approve/reject) moderation exists |
| App Name consistency | ⚠ Needs attention — "Fcom Messenger" (`index.html`) vs. "Fcom — The Digital Universe" (`landing.html`) disagree |
| Support URL / Marketing URL | ❌ Missing — no production domain configured anywhere |
| Age rating vs. actual audience | ⚠ Needs attention — school/grade-based registration implies a likely-minors audience, in tension with the conservative 17+ rating the current lack of moderation would otherwise justify |
| Account-level moderation (approve/reject) | ✅ Completed — working, verified, including live auto-refresh via existing `SYNC_EVENT` mechanism |
| Sign in with Apple (Guideline 4.8) | ✅ Not applicable — no third-party/social login offered, so this guideline isn't triggered |
| Push notification compliance | ✅ Not applicable — no push notifications exist, none claimed |
| RLS on new Reports/Blocks tables | ✅ Completed (as designed, pending implementation) |
| RLS on existing `chat_groups`/`group_members`/`group_invites` | ❌ Missing / broken — critical, pre-existing, unaddressed by this entire batch |

## 9. Required Changes Before Development

1. **Manually reconcile the three-way `resetAll()` edit and the four-way `init()` edit** into single combined diffs before any implementation begins (§3.1, §3.2).
2. **Fix RLS/grants on `chat_groups`/`group_members`/`group_invites`** — this is a live critical vulnerability, independent of and higher priority than any of the 6 feature proposals.
3. **Decide the onboarding backfill strategy** before implementing Onboarding — either seed `credo_onboarding_seen = true` for all pre-existing users at migration time, or gate the onboarding check on `createdAt` being after a cutover timestamp, so existing users aren't interrupted.
4. **Resolve the `credo_blocked` vs. `credo_user_blocks` naming collision risk** before writing code — rename one of them if there's still time.
5. **Decide whether the Report/Block Edge Function block-check needs to extend to group messages**, or whether 1:1-only is acceptable for MVP — currently silently 1:1-only.
6. **Add an account-deletion flow to the Settings Screen proposal** (or explicitly decide to defer App Store submission until it exists) — currently a gap between two proposals that individually look complete.
7. **Reconcile the App Name** between `index.html` and `landing.html` before any App Store metadata work proceeds.
8. **Verify `handleServerSync()`'s interaction with the new Onboarding screen** during implementation (§3.5) rather than assuming it's inert.
9. Author the missing Privacy Policy, Terms of Service, and Community Guidelines — these are blocking regardless of code readiness and should be started in parallel, not after implementation.

## 10. Questions For The Lead Developer

1. Should the `chat_groups`/`group_members`/`group_invites` RLS fix be scheduled as its own, higher-priority task before any of these 6 features ship, given it's a live critical vulnerability?
2. For Onboarding: should existing users be exempted entirely, or is a one-time "what's new" version of onboarding intentionally desired for them too?
3. Is 1:1-only blocking acceptable for MVP, or does group-chat blocking need to be in scope before this ships?
4. Should `credo_user_blocks` be renamed to reduce confusion with the existing `credo_blocked` (device-block) key?
5. Should the `refreshBlockedUsers()` call be moved off the unconditional 2-second hot path (e.g., only on login/status-change) to avoid compounding the polling architecture's existing cost?
6. Is account deletion being deliberately deferred to a later milestone, or should it be pulled into the Settings Screen scope now, before implementation starts on Settings?
7. Which App Name is canonical, and is a native-wrapper strategy for iOS distribution already decided outside of what's visible in this repository?
8. Should the Reports/Blocks migration and a `chat_groups` RLS-hardening migration be bundled into the same review/deploy cycle, given they're both RLS-focused changes touching the same area of the schema?
9. Is the small custom UI needed for report-reason selection acceptable as the project's first non-`alert()`/`confirm()` interaction pattern, and should its visual design be reviewed separately before implementation?

## 11. Confidence

| Conclusion | Basis |
|---|---|
| `resetAll()` currently has 9 lines / triple-edit risk is real | Existing source code, re-verified this session (`credo.js:543-553`) |
| `credo_blocked` already exists and is the device-block key, distinct from proposed `credo_user_blocks` | Existing source code, re-verified this session (`credo.js:551`, `isDeviceBlocked`/`blockDevice` in the same file's public API) |
| `chat_groups`/`group_members`/`group_invites` migration has no RLS/GRANT/REVOKE statements | Existing source code, re-verified this session by direct search of `supabase/migrations/20260517153000_024_groups_and_media.sql` — **zero matches**, confirming (not just repeating) the original audit's finding |
| `renderChatList`, `openUserProfile`, `openChat` exist exactly as the Report/Block proposal assumes | Existing source code, re-verified this session (`app.js:518, 1088, 1159`) |
| `handleServerSync()`'s exact branching logic and its interaction risk with Onboarding | Existing source code (`app.js:1866-1920`, examined in the prior Waiting-for-Moderation review) + inference about the *consequence* of that interaction with a screen (Onboarding) that didn't exist when `handleServerSync` was written |
| Onboarding lacks a backfill mechanism for existing users | Inference from the proposal's described design (`hasSeenOnboarding` defaulting false, no migration/seed step mentioned) — not verified against actual onboarding code since it was never committed to the repo (this entire engagement has been proposal-only) |
| Reports/Blocks RLS design is correct and intentionally contrasts with `chat_groups` | Project documentation (the proposal's own migration comments, produced earlier in this engagement) + this session's independent re-verification of the `chat_groups` migration |
| Group-chat blocking gap | Inference from the proposed `isBlockedEitherWay(userA, userB)` function signature, which is structurally incompatible with N-participant group messages |
| App Store readiness table | Project documentation (the App Store proposal produced earlier in this engagement), re-cross-checked against the Settings Screen proposal's actual described scope for the account-deletion gap specifically |
| Figma-sourced design consistency | **Not verified via Figma MCP** — unavailable this session, consistent with every prior finding in this engagement that no Figma file exists in the repository at all |
| Live Supabase RLS/grants for `reports`/`user_blocks` as actually deployed | **Not verified via Supabase MCP** — unavailable this session; conclusions are based on the proposed migration SQL text only, since nothing has been deployed yet (confirmed no such tables exist in the current migration folder) |
| Context7 / official Apple guideline citations (1.2, 5.1.1(v), 4.8) | General stable policy knowledge, not re-fetched this session — no version-specific or ambiguous detail was in question |

---

No project files were modified, no commits or branches were created, no database changes were executed, and nothing was deployed. This is a synthesis review of prior proposals only, intended to be handed to the lead developer before any of the 8 items above move into actual implementation.