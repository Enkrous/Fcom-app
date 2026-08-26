# Combined File: Onboarding, Waiting for Moderation, App Store Preparation

> **Note:** This file concatenates three distinct original responses, produced in three separate turns, as requested by the filename grouping. Each section below is the complete, unedited original response for that turn.

---

# ORIGINAL RESPONSE 1 of 3 — Onboarding Flow

---

# Onboarding Flow — Implementation Proposal

*No files modified, no commits, no branches, no database changes, nothing deployed. This is a standalone proposal for lead-developer review.*

---

## Pre-work performed (Step 1 & Step 2, facts gathered before proposing anything)

- **Existing onboarding flow**: none exists. Confirmed by tracing the entire auth/launch state machine in `route()` (`app.js:253-313`) — it only handles: device-blocked → no-user (register/login) → rejected → phone-not-verified → **pending-approval** (`#screen-pending`, already implemented) → approved-but-no-password (`#screen-set-password`, already implemented) → main. There is no tutorial/walkthrough/first-run-explainer step anywhere in this chain.
- **Important correction to the original 8-task plan's framing**: the "Waiting for Moderation Screen" (`#screen-pending`, `index.html:200-210`) **already exists and is fully wired** in `route()` — it is not a gap. This matters for Onboarding's design: there's no need to re-explain "your account is pending approval" inside onboarding, since the existing pending screen already does that. Onboarding should therefore be scoped to **product concepts**, not **account-state explanations** — those are already covered.
- **Registration flow** traced end-to-end (`handleRegister` → optional OTP `handleVerifyPhone` → `route()` → pending screen → (peer approval, off-app) → `handleSetPassword` → `route()` → main). Onboarding's natural, non-redundant insertion point is **the first time `route()` would otherwise show `main`** — i.e., after the account is fully active (approved + password set), immediately before the very first view of the real app.
- **Reusable UI components** inventoried: `.screen`/`.screen-shell`, `.auth-shell`, `.glass-panel`, `.auth-card`/`.compact-card`/`.status-card`, `.auth-head`/`.auth-head-center`, `.brand`/`.brand-mark`/`.brand-copy`, `.hero-point` (feature-highlight card, exact CSS at `style.css:772-792`), `.status-icon` (`style.css:705-711`), `.btn`/`.btn-primary`/`.btn-outline`/`.btn-block`, `.hint`.
- **Reusable navigation**: the `screens` object + `showScreen(name)` (`app.js:176`) + the established idiom of "handler completes a step → calls `route()` again" (used identically by `handleRegister`, `handleVerifyPhone`, `handleSetPassword`, `handleLogin`).
- **Reusable state management**: the `credo_*` localStorage convention, most directly comparable to the (proposed, not-yet-applied) `credo_settings` pattern — a small per-user JSON flag object, read/written only through `credo.js`.
- **Reusable design tokens**: `--blue`/`--cyan`/`--violet`/`--gold` (already used for the four Credo trust levels' accent colors), `--radius-*`, `--shadow-*`, `--font-display`/`--font-body`.
- **Reusable animations**: `@keyframes screen-in` (already applied to every `.screen` automatically) and `@keyframes message-in` — no new animation keyframes are introduced; step transitions reuse the existing `.tab-pane`-style `hidden`-class toggling already used by `showTab()`.
- **Coding conventions confirmed**: Russian-language UI copy throughout; `$`/`$$` DOM helpers; `'use strict'` + IIFE module pattern (`const X = (() => { ... return {...} })()`); handlers named `handleX`; no build step, no external libraries.
- **Backend/Supabase**: not required. Onboarding is a one-time, purely informational client-side explainer with no data that needs to be shared across devices or visible to other users — the same reasoning already used for the (proposed) Settings screen's local-only notification preference. **Supabase MCP was not queried for this task** since nothing here depends on backend state — this is a deliberate, reasoned scoping decision, not an oversight.
- **Figma MCP**: re-checked. As established in the two prior sessions, **no Figma file is linked to or discoverable from this repository** — confirmed again by searching the repo for any `figma.com`/file-key reference (none found). Figma cannot be the source of truth here; this proposal is grounded entirely in the app's existing implemented screens and design tokens instead. Stated as fact, not assumption.
- **Context7**: not queried — this task is a vanilla-JS/HTML/CSS change with no SwiftUI or framework API involved, so Context7 (scoped to "official SwiftUI or framework documentation") does not apply here.

---

## 1. Architecture Integration

Onboarding is implemented as **one additional top-level screen** (`onboarding`) inside the existing `screens` map — not a new routing concept, not a new state-management system, not a new component library. It slots into the existing state machine at exactly one point: `route()` already decides, in order, whether to show blocked/register/login/rejected/verify-phone/pending/set-password/main. This proposal adds exactly one more check, in the same style as the existing ones, immediately before the final `main` fallback: *"has this user already seen onboarding? If not, show it before main."*

Completion follows the codebase's own established idiom exactly: every existing auth step (`handleRegister`, `handleVerifyPhone`, `handleSetPassword`, `handleLogin`) ends by calling `route()` again so the state machine re-evaluates and advances. Onboarding's "Начать" (Get Started) button does the same: mark the flag, call `route()`, and the existing logic naturally falls through to `main` on the next evaluation. No new navigation primitive is introduced.

Internally, onboarding's 3 steps are **not** 3 separate entries in the `screens` map (that would require `route()` to understand "step 2 of onboarding" as a distinct global app state, which it isn't — there's no server-side or cross-device concept of an onboarding step). Instead, one `screens.onboarding` entry contains 3 internally-toggled `.onboarding-step` panels, shown/hidden exactly the way `showTab()` already toggles `.tab-pane` elements inside `#screen-main`. This reuses an existing pattern rather than inventing a stepper/carousel component.

## 2. Existing Project Assets

**Reusable components**
- `.screen` / `.screen-shell` / `.auth-shell` — top-level screen shell and centering layout.
- `.glass-panel` / `.status-card` — the frosted card container (same one used by `#screen-pending`/`#screen-blocked`).
- `.status-icon` — the circular icon badge used by pending/blocked screens.
- `.hero-point` — the small labeled feature-card used on the register/login hero panels; reused as the per-step "concept card."
- `.brand` / `.brand-mark` / `.brand-copy` — the "F" mark + title/subtitle pairing.
- `.btn` / `.btn-primary` / `.btn-outline` / `.btn-block` — all button styling.
- `.hint` — muted helper text style.

**Reusable services**
- None from the backend layer (`api.js`) — onboarding is intentionally client-only, so no Edge Function or `_call()` usage is introduced.
- `Credo.getUserById` / `Credo.getCurrentUserId` — read the current user to personalize copy (nickname) if desired.

**Reusable navigation**
- `screens` map + `showScreen(name)`.
- The "handler finishes → calls `route()`" completion idiom.

**Reusable models**
- The existing `users` row shape (`nickname`, `school`) — no new fields, no schema change.

**Reusable utilities**
- `loadJSON`/`saveJSON` helpers already inside `credo.js` — reused verbatim for the new local flag.

**Reusable design tokens**
- `--blue`, `--cyan`, `--violet` (one accent per onboarding step, matching the existing three "signal" accents already used elsewhere in the design system) — no new colors introduced.
- `--radius-lg`/`--radius-md`, `--shadow-lg`, `--font-display`.

## 3. User Flow

**Screen sequence**: `register/login` → (OTP if phone given) → `pending` (peer approval, off-app, existing) → `set-password` (existing) → **`onboarding` (new, first time only)** → `main` (existing).

**Navigation**: entirely handled by the existing `route()` re-evaluation idiom — no new routing function, no URL/hash changes, no browser history entries.

**User actions**:
- **Далее** (Next) — advances from step 1→2, 2→3.
- **Пропустить** (Skip) — visible on every step; immediately marks onboarding as seen and proceeds to `main`.
- **Начать** (Get Started) — replaces "Далее" on step 3; marks onboarding as seen and proceeds to `main`.
- Step dots (visual only, non-interactive in this MVP — see Questions §9) indicate progress.

**Edge cases**:
- **Returning user, new device**: since the "seen" flag is a local (per-browser) cache — same deliberate scoping decision as the Settings screen's local-only preference — a user logging in on a second device will see onboarding once more on that device. This is called out explicitly in §9 rather than silently decided.
- **User resets local data** (`Credo.resetAll()` / "Сбросить" in the demo bar): onboarding will show again on next login, since the flag lives in the same localStorage that gets wiped — consistent with every other local-only flag in the app (e.g. `credo_blocked`, `credo_current_user`).
- **Admin users**: onboarding content in this proposal is written for regular members (registration → approval → chat/groups). Admin-specific concepts (approving/rejecting members) are **not** covered by this MVP — flagged in §9.
- **User navigates away mid-onboarding** (e.g. closes tab): since nothing is marked "seen" until Skip/Get Started is clicked, they will see onboarding again from step 1 on next login — acceptable, matches how `pending`/`set-password` also have no partial-completion state.
- **Local-only (no backend) mode**: onboarding works identically — it never touches `api.js`/`FUNCTIONS_BASE`, so there is no `not_supported_local` branch needed here at all, unlike Report/Block. This is simpler than those proposals specifically because onboarding has no server-facing behavior whatsoever.

**Completion flow**: `markOnboardingSeen(userId)` → `route()` → falls through every earlier check (user is approved, has password) straight to `showScreen('main')`.

## 4. Implementation Strategy

1. **State (`credo.js`)**: add a minimal local flag store, `credo_onboarding_seen`, structurally identical to the (proposed) `credo_settings` pattern — a JSON object keyed by `userId`. Two functions: `hasSeenOnboarding(userId)` and `markOnboardingSeen(userId)`.
2. **Markup (`index.html`)**: add one new `<section id="screen-onboarding">` containing 3 `.onboarding-step` panels (only one visible at a time via `hidden`), a step-dots indicator, and a fixed footer with Skip/Next/Get Started buttons. Placed as a sibling of the other screens, directly before `#screen-main` (the screen it leads into).
3. **Styling (`style.css`)**: a small, additive block of new rules scoped to `.onboarding-*` classes — reusing `.glass-panel`/`.status-card`/`.hero-point` wherever possible, only adding what doesn't already exist (the step-dots indicator and the icon-badge color variants per step).
4. **Behavior (`app.js`)**:
   - Register `onboarding: $('#screen-onboarding')` in the `screens` map.
   - Add one internal state variable, `_onboardingStep`.
   - Add `renderOnboardingStep()` (shows the current step panel, updates dots/button label).
   - Add three thin handlers: `handleOnboardingNext()`, `handleOnboardingSkip()`, `handleOnboardingFinish()`.
   - Modify `route()`: insert one new check, in the same shape as its existing checks, immediately before the final `main` fallback.
   - Wire the three buttons in `init()`, alongside all the other event-listener wiring already done there.

No new top-level files are introduced — everything fits inside the four files that already define the equivalent auth-flow screens, matching the instruction to introduce new files only when absolutely necessary (it isn't necessary here).

## 5. Required Changes

**Existing files that would change**: `index.html`, `app.js`, `credo.js`, `style.css`.
**New files**: none.
**New assets**: none — no images/icons are needed; the step badges reuse the existing `.status-icon` circular-badge pattern with a single Cyrillic/symbol glyph, the same technique already used for `.brand-mark` ("F") and `.status-icon` ("!", "…").

---

## 6. Complete Implementation

### `credo.js`

**Header doc comment** — extend the localStorage key list:

```javascript
/**
 * credo.js — Ядро системы «Кредо» (уровень доверия)
 *
 * Все данные хранятся в localStorage.
 * Ключи:
 *   credo_users            — JSON-массив пользователей
 *   credo_rate_log         — JSON-массив всех оценок
 *   credo_chats            — JSON-объект { "u1::u2": [...messages] }
 *   credo_blocked          — "true" если устройство заблокировано
 *   credo_current_user     — id текущего пользователя
 *   credo_onboarding_seen  — JSON-объект { [userId]: true }, локально на устройстве
 */
```

**New functions** — placed near the other small local-flag helpers (same section style as the rest of the file):

```javascript
  // --------------- Онбординг (локальный, per-device) ---------------
  // credo_onboarding_seen — JSON-объект { [userId]: true }
  // Хранится только на этом устройстве — не синхронизируется с backend,
  // тот же принцип, что и у локальных настроек уведомлений.

  function hasSeenOnboarding(userId) {
    if (!userId) return false;
    const seen = loadJSON('credo_onboarding_seen', {});
    return Boolean(seen[userId]);
  }

  function markOnboardingSeen(userId) {
    if (!userId) return;
    const seen = loadJSON('credo_onboarding_seen', {});
    seen[userId] = true;
    saveJSON('credo_onboarding_seen', seen);
  }
```

**`resetAll()`** — add the new key to the existing cleanup list:

```javascript
  function resetAll() {
    localStorage.removeItem('credo_users');
    localStorage.removeItem('credo_rate_log');
    localStorage.removeItem('credo_chats');
    localStorage.removeItem('credo_groups');
    localStorage.removeItem('credo_group_invites');
    localStorage.removeItem('credo_group_chats');
    localStorage.removeItem('credo_device_accounts');
    localStorage.removeItem('credo_blocked');
    localStorage.removeItem('credo_current_user');
    localStorage.removeItem('credo_onboarding_seen');
  }
```

**Public API export** — add to the returned object:

```javascript
  return {
    // Данные
    updateUser,
    getUsers,
    getDeviceAccounts,
    getUserById,
    getCurrentUserId,
    setCurrentUserId,
    markDeviceAccount,
    keepOnlyDeviceAccount,
    isDeviceBlocked,
    blockDevice,

    // Онбординг
    hasSeenOnboarding,
    markOnboardingSeen,

    // Регистрация
    registerUser,
    approveUser,
    rejectUser,

    // ... rest of the existing export list, unchanged ...
  };
```

---

### `index.html`

New section, inserted directly before `<section id="screen-main" class="screen hidden">`:

```html
<section id="screen-onboarding" class="screen hidden">
  <div class="screen-shell auth-shell">
    <div class="glass-panel status-card onboarding-card">
      <div class="auth-head">
        <button id="onboarding-skip-btn" class="btn btn-outline btn-small" type="button">Пропустить</button>
      </div>

      <div class="onboarding-step" data-step="1">
        <div class="status-icon onboarding-icon onboarding-icon--credo">К</div>
        <h2>Кредо — уровень доверия</h2>
        <p class="subtitle">У каждого участника есть Кредо — число, которое растёт по мере того, как вас узнают другие пользователи школы.</p>
        <div class="hero-point">
          <strong>Новичок → Знакомый → Доверенный → Свой</strong>
          <span>Кредо повышается, когда другие участники ставят вам хорошие оценки после общения, и снижается — если оценки плохие.</span>
        </div>
      </div>

      <div class="onboarding-step hidden" data-step="2">
        <div class="status-icon onboarding-icon onboarding-icon--chat">Ч</div>
        <h2>Чаты и группы</h2>
        <p class="subtitle">Пишите напрямую любому одобренному участнику вашей школы или общайтесь в группах.</p>
        <div class="hero-point">
          <strong>Личные диалоги и группы</strong>
          <span>Школьный публичный чат создаётся автоматически, а закрытые группы — только по приглашению участников.</span>
        </div>
      </div>

      <div class="onboarding-step hidden" data-step="3">
        <div class="status-icon onboarding-icon onboarding-icon--community">С</div>
        <h2>Сообщество школы</h2>
        <p class="subtitle">Новых участников одобряют уже одобренные пользователи той же школы — так сообщество остаётся настоящим.</p>
        <div class="hero-point">
          <strong>Вы тоже сможете одобрять</strong>
          <span>Как только вас одобрят, вы увидите заявки других новых участников вашей школы во вкладке «Участники».</span>
        </div>
      </div>

      <div class="onboarding-dots" id="onboarding-dots" aria-hidden="true">
        <span class="onboarding-dot is-active" data-dot="1"></span>
        <span class="onboarding-dot" data-dot="2"></span>
        <span class="onboarding-dot" data-dot="3"></span>
      </div>

      <button id="onboarding-next-btn" class="btn btn-primary btn-block" type="button">Далее</button>
    </div>
  </div>
</section>
```

---

### `style.css`

New additive block (append near the other auth-screen rules, e.g. after `.status-icon`'s existing definition):

```css
.onboarding-card {
  gap: 22px;
}

.onboarding-step h2 {
  margin: 0 0 4px;
}

.onboarding-icon {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
}

.onboarding-icon--credo {
  background: linear-gradient(160deg, rgba(77, 166, 255, 0.28), rgba(34, 211, 238, 0.16));
}

.onboarding-icon--chat {
  background: linear-gradient(160deg, rgba(139, 92, 246, 0.28), rgba(77, 166, 255, 0.16));
}

.onboarding-icon--community {
  background: linear-gradient(160deg, rgba(255, 213, 79, 0.28), rgba(139, 92, 246, 0.16));
}

.onboarding-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
}

.onboarding-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  transition: background 180ms ease, transform 180ms ease;
}

.onboarding-dot.is-active {
  background: var(--blue);
  transform: scale(1.25);
}
```

*(No new keyframes are introduced — each `.onboarding-step` swap reuses the existing `hidden`-class toggle already relied on throughout the codebase; the screen itself still gets the existing `screen-in` entrance animation automatically since `.screen` already declares it.)*

---

### `app.js`

**1. `screens` map** — add one entry (`app.js:20-31`):

```javascript
  const screens = {
    setPassword:  $('#screen-set-password'),
    login:        $('#screen-login'),
    blocked:      $('#screen-blocked'),
    register:     $('#screen-register'),
    pending:      $('#screen-pending'),
    onboarding:   $('#screen-onboarding'),
    main:         $('#screen-main'),
    rate:         $('#screen-rate'),
    chat:         $('#screen-chat'),
    verifyPhone:  $('#screen-verify-phone'),
    userProfile:  $('#screen-user-profile'),
  };
```

**2. New state variable** — alongside the other `let` state declarations (`app.js:34-52`):

```javascript
  let _onboardingStep = 1; // 1..3 — текущий шаг онбординга
```

**3. New functions** — placed near `route()`/`openExperience()` (same neighborhood as the other screen-sequencing logic):

```javascript
  // --------------- Онбординг ---------------

  const ONBOARDING_TOTAL_STEPS = 3;

  function renderOnboardingStep() {
    $$('.onboarding-step').forEach((el) => {
      el.classList.toggle('hidden', Number(el.dataset.step) !== _onboardingStep);
    });

    $$('.onboarding-dot').forEach((dot) => {
      dot.classList.toggle('is-active', Number(dot.dataset.dot) === _onboardingStep);
    });

    const nextBtn = $('#onboarding-next-btn');
    if (nextBtn) {
      nextBtn.textContent = _onboardingStep === ONBOARDING_TOTAL_STEPS ? 'Начать' : 'Далее';
    }
  }

  function handleOnboardingNext() {
    if (_onboardingStep >= ONBOARDING_TOTAL_STEPS) {
      handleOnboardingFinish();
      return;
    }
    _onboardingStep += 1;
    renderOnboardingStep();
  }

  function handleOnboardingSkip() {
    handleOnboardingFinish();
  }

  function handleOnboardingFinish() {
    const userId = Credo.getCurrentUserId();
    if (userId) Credo.markOnboardingSeen(userId);
    route();
  }
```

**4. `route()` modification** — insert one new check immediately before the final `main` fallback (`app.js:296-312`, full function shown with the change applied so the insertion point is unambiguous):

```javascript
  function route() {
    if (Credo.isDeviceBlocked()) {
      showScreen('blocked');
      return;
    }

    const userId = Credo.getCurrentUserId();

    // Нет текущего пользователя — показать логин (или регистрацию если нет пользователей)
    if (!userId) {
      const users = _getLocalAccounts();
      if (_isBackendMode()) {
        showScreen('login');
      } else if (users.length === 0) {
        showScreen('register');
      } else {
        showScreen('login');
      }
      return;
    }

    const user = Credo.getUserById(userId);

    if (!user) {
      Credo.setCurrentUserId(null);
      showScreen(_isBackendMode() ? 'login' : (_getLocalAccounts().length === 0 ? 'register' : 'login'));
      return;
    }

    _enforceSingleAccountForRegularUser(user);

    if (user.status === 'rejected') {
      showScreen('blocked');
      return;
    }

    if (user.phone && user.phoneVerified === false) {
      _pendingPhone = user.phone;
      $('#verify-phone-number').textContent = _pendingPhone;
      showScreen('verifyPhone');
      return;
    }

    if (user.status === 'pending') {
      $('#pending-nickname').textContent = `@${user.nickname}`;
      showScreen('pending');
      return;
    }

    // approved — проверяем наличие пароля
    if (user.status === 'approved' && !user.passwordHash) {
      $('#setpass-nickname').textContent = `@${user.nickname}`;
      showScreen('setPassword');
      return;
    }

    // Первый вход после полной активации аккаунта — показать онбординг один раз.
    if (!Credo.hasSeenOnboarding(user.id)) {
      _onboardingStep = 1;
      renderOnboardingStep();
      showScreen('onboarding');
      return;
    }

    // Всё ок — главный экран
    showScreen('main');
    renderMainScreen(user);
    showTab('chats');
  }
```

**5. Event wiring in `init()`** — add alongside the existing auth-related wiring (`app.js:1947` area):

```javascript
    // Онбординг
    $('#onboarding-next-btn').addEventListener('click', handleOnboardingNext);
    $('#onboarding-skip-btn').addEventListener('click', handleOnboardingSkip);
```

---

## 7. Architecture Validation

- **Existing architecture**: no new module, no new global object, no build tooling — everything lives inside the same four flat files the rest of the app already uses, following the same IIFE-module + `$`/`$$` conventions.
- **Navigation**: reuses the `screens` map / `showScreen()` mechanism verbatim; reuses the exact "handler completes → calls `route()`" idiom already used by every other auth step, so `route()` remains the single source of truth for "what screen should be visible right now" — onboarding doesn't introduce a second, competing routing authority.
- **State management**: reuses the `credo_*` localStorage convention and the `loadJSON`/`saveJSON` helpers unchanged; introduces no new storage mechanism (no cookies, no IndexedDB, no new global JS variable holding persisted state).
- **Design system**: 100% reuse of existing classes (`.glass-panel`, `.status-card`, `.status-icon`, `.hero-point`, `.btn*`) and existing color tokens (`--blue`/`--cyan`/`--violet`/`--gold`); the only new CSS is the step-dots indicator, which has no existing equivalent to reuse.
- **Coding conventions**: function names (`handleOnboardingNext`, `renderOnboardingStep`), Russian UI copy, and comment style all match the surrounding code exactly (compare `handleSetPassword`/`renderSettingsScreen`-style naming from the earlier Settings proposal).

## 8. Risks

**UX risks**
- Showing onboarding *after* the pending-approval wait (which can take real-world time, hours to days) means it appears at a moment the user is eager to just start using the app — a 3-step explainer here could feel like one more gate. Mitigated by making every step skippable and keeping total content short (3 short cards, no forced reading time).
- The step-dots are decorative only in this MVP (not clickable) — a user who accidentally skipped past a concept can't jump back without re-triggering the whole flow (which they can't, since it's marked "seen" after finishing).

**Navigation risks**
- Low. The single new `route()` check sits in an `if...return` chain identical in shape to its neighbors — but it does mean **every** future new "gate" added to `route()` must be ordered carefully relative to this one and to `pending`/`setPassword`, since order in that function is the only thing determining precedence. Worth a code comment (already included above) marking why onboarding is checked last.

**Maintainability risks**
- The 3-step content is static HTML text, not data-driven — adding/removing/reordering a step requires touching `index.html`, `app.js` (`ONBOARDING_TOTAL_STEPS`), and possibly `style.css` in three places rather than one config array. Acceptable for a 3-step MVP; would need restructuring into a data-driven step list before scaling to, say, 6+ steps.

**Future scalability risks**
- If admin-specific onboarding content is later needed (see §9), the current design has no per-role branching — it would need a conditional step set keyed on `_isAdmin(user)`, which isn't built here.
- If onboarding is ever asked to sync across devices (rather than stay local-only), the `credo_onboarding_seen` flag would need to move server-side (e.g. a new `users` column or a small new table) — a materially bigger change than anything proposed here, deliberately deferred.

## 9. Questions For The Lead Developer

1. **Per-device vs. per-account "seen" state**: is it acceptable that onboarding reappears once per new device/browser (local-only flag), or should it eventually be tracked server-side so it truly shows only once per account? This mirrors the same open question already raised for the Settings screen's notification preference.
2. **Admin-specific content**: should admins see additional or different onboarding content (e.g. explaining the approval/moderation responsibilities), or is the current member-focused 3-step content acceptable for everyone including admins for this MVP?
3. **Content accuracy/tone**: the 3 concepts chosen (Кредо levels, chats/groups, peer-approval community) were selected by re-reading the actual implemented features (not from a design brief, since none exists) — please confirm this is the right set and depth of concepts, or adjust before implementation.
4. **Step-dots interactivity**: should users be able to tap a dot to jump between steps, or is forward-only navigation (plus Skip) sufficient for an MVP?
5. **Placement relative to `pending`**: this proposal places onboarding *after* approval + password setup (right before first `main` view). An alternative is showing a *shorter* teaser version immediately after registration, before the pending wait even begins. Which moment is preferred — or both?
6. **Figma**: as in prior proposals, no Figma file exists for this project. Should this proposal's copy/layout be treated as the design, or is a design pass expected first?

## 10. Confidence

| Decision | Basis |
|---|---|
| `#screen-pending`/`#screen-set-password` already fully implemented; exact `route()` state-machine order | **Existing source code** (`app.js:253-313`, `index.html:132-210`) — fact |
| No existing onboarding/tutorial flow anywhere in the app | **Existing source code** (full trace of `route()`, `screens` map, grep across `app.js`) — fact |
| No Figma file linked to this project | **Figma MCP** — checked again this session; fact (absence confirmed, not assumed) |
| Context7/SwiftUI not applicable | **Inference** from the task's own scoping instruction ("only when official SwiftUI or framework documentation is required") combined with the fact this is a vanilla-JS project — fact that the condition doesn't apply |
| Reusable classes (`.glass-panel`, `.status-card`, `.hero-point`, `.status-icon`, button variants) and their exact CSS definitions | **Existing source code** (`style.css`, direct reads) — fact |
| Credo level names/thresholds (Новичок/Знакомый/Доверенный/Свой, 0-4/5-14/15-29/30+) used in onboarding copy | **Existing source code** (`credo.js:124-133`) — fact, not paraphrased |
| Placement of onboarding after password-setup, before first `main` view | **Inference** — reasoned from the existing state machine's structure and the goal of not duplicating the pending screen's content, but this is a product/UX decision and is explicitly raised in §9 rather than asserted as the only correct answer |
| 3-step content selection (Кредо, Chats/Groups, Community/Approval) | **Inference**, grounded in what the app's actually-implemented features are (re-derived from `credo.js`/`groups/index.ts`/`users/index.ts` in earlier sessions), not from any design brief — flagged as a question, not presented as settled |
| Local-only (not server-synced) "seen" flag | **Inference by precedent** — directly modeled on the (proposed, not-yet-merged) Settings screen's `credo_settings` local-only pattern, for architectural consistency; explicitly flagged as an open question in §9 rather than decided unilaterally |
| No backend/Supabase changes needed | **Inference**, reasoned from the feature having no cross-device or cross-user data requirement — consistent with the task instruction to only inspect Supabase "if onboarding depends on backend functionality," which it was determined not to |

---

# ORIGINAL RESPONSE 2 of 3 — Waiting for Moderation Screen

---

# Implementation Proposal — Waiting for Moderation Screen

## Important finding before anything else

Before proposing changes, I re-verified the current state of this screen directly in the source (not from the prior summary, from the live files). The result changes the shape of this proposal:

**The Waiting for Moderation screen already exists, is already wired into the registration/approval flow, and already has a working real-time auto-refresh mechanism.** This is not a "build from scratch" task — it's a "verify, and optionally polish" task. I want to be explicit about that rather than manufacture a bigger implementation than what's actually needed, per the instruction not to redesign existing systems.

Evidence (exact locations):

| Piece | Location | What it does |
|---|---|---|
| Screen markup | `index.html:200-210` (`#screen-pending`) | Static `.glass-panel.status-card` with nickname interpolation and a "Вернуться на лендинге" exit |
| Screen registered in router | `app.js:25` (`screens.pending`) | Included in the `screens` map used by `showScreen()` |
| Gating logic | `app.js:296-300` inside `route()` | Shows `pending` when `user.status === 'pending'` (after the blocked/rejected/phone-verify checks) |
| **2-second background polling** | `api.js:309-358` (`syncNow`, `startLiveSync`) | Polls `/me` every 2s via `_syncCurrentUser()`, using either the reg-token or session token |
| **Live sync started right after registration** | `api.js:460` (end of `register()`) | `startLiveSync()` fires the moment a user lands on the pending screen |
| **Live sync resumed on page reload** | `api.js:836-858` (`_init`) | If `hasSessionToken()` (session OR reg token) and a current user exist, sync resumes automatically |
| **Change → event** | `api.js:88`, `SYNC_EVENT = 'fcom:server-sync'` | Dispatched only when polling detects a real change |
| **Event → UI transition** | `app.js:1866-1920` (`handleServerSync`), wired at `app.js:2089-2091` | If `user.status !== 'approved'`, calls `route()`, which re-evaluates and moves the user off the pending screen the instant the backend flips their status |
| Backend source of truth | `supabase/functions/me/index.ts:21-25` | Returns `status` straight from `public.users`, no caching |
| Approval path | `supabase/functions/approve/index.ts` | Admin-only, `SECURITY DEFINER` RPC `approve_and_log`, sets `status = 'approved'` + `cred = 1` |
| Logout cleanup | `api.js:582-595` (`logout`) | Clears both tokens and calls `stopLiveSync()` — no orphaned timers |

So the actual end-to-end behavior today is:

1. User registers → gets `status: 'pending'` → lands on `#screen-pending` → `startLiveSync()` begins.
2. Every 2s, the client silently calls `/me`. As long as `status` stays `'pending'`, nothing visibly changes.
3. An admin approves (or rejects) the user via `/functions/v1/approve` (or `/reject`).
4. Within ≤2 seconds, the next poll picks up the new status, `SYNC_EVENT` fires, `handleServerSync()` runs, `route()` re-evaluates, and the user is automatically moved to `setPassword` (first approval), `main` (already has a password), or `blocked` (rejection) — **with no manual refresh needed.**

I confirmed this is real, not a coincidence of naming — `handleServerSync` was clearly written for exactly this purpose and is actively registered as a listener, not dead code (unlike the `.loader` CSS class flagged in the earlier Lottie proposal, which genuinely is unused).

Given this, the rest of this proposal focuses on the **narrow, genuinely missing pieces**: user-facing feedback that something is happening in the background, and a manual fallback affordance. Everything else is intentionally left untouched.

---

## 1. Architecture Integration

The screen sits in the same state machine as every other auth screen, gated by the single `route()` function (`app.js:253-313`), which is a strict priority ladder:

```
isDeviceBlocked()  → 'blocked'
no currentUserId   → 'login' / 'register'
user not found     → 'login' / 'register'
status === 'rejected'        → 'blocked'
phone set & unverified       → 'verifyPhone'
status === 'pending'         → 'pending'   ← this screen
approved, no passwordHash    → 'setPassword'
otherwise                    → 'main'
```

Nothing about this ladder needs to change. The pending screen is a **terminal state that resolves itself** via the sync loop described above — it's not a dead end the user has to escape manually.

The only integration point I'm proposing to touch is the render step at `app.js:296-300`, where `$('#pending-nickname').textContent` is already set — I'd extend this same block to also populate a "last checked" timestamp and wire a manual-refresh button. No changes to `route()`'s branching logic, no changes to `handleServerSync()`, no changes to the sync engine in `api.js`.

## 2. Existing Project Assets

Reused as-is, unchanged:

- **Screens map / router**: `screens.pending`, `route()`, `showScreen()` (`app.js`)
- **Sync engine**: `API.syncNow()`, `API.startLiveSync()`, `API.SYNC_EVENT`, `handleServerSync()` — this is the core piece being *activated in the UI*, not rebuilt
- **Visual components**: `.glass-panel`, `.status-card`, `.status-icon`, `.screen-shell.auth-shell`, `.subtitle`, `.hint`, `.btn.btn-outline` (all defined in `style.css`, all already used by the sibling `#screen-blocked` and `#screen-verify-phone` screens)
- **Design tokens**: `--muted`, `--blue`, `--cyan`, `--gold`, `--font-mono`, `--font-display` (`style.css:8-29`)
- **Exit action**: `[data-go-home]` → `closeExperience` (`app.js:2093-2095`) — reused unchanged
- **Models**: `users.status`, `users.role`, `users.cred` (via `/me`) — no schema reuse needed, no new columns
- **Utility**: `escapeHtml()` (`app.js`) if any dynamic text is inserted (nickname already uses `textContent`, which is safe as-is)

Nothing new needs to be introduced at the component/service/model level — this task is UI-affordance-only.

## 3. User Flow

**When shown:** Immediately when `route()` runs for a user whose `status === 'pending'` — right after registration, and on every subsequent app load/tab switch/sync event while still pending.

**How status is checked:** Already automatic — `startLiveSync()` polls `/me` every 2 seconds in the background (`api.js:352-358`). This is confirmed active on this screen because `register()` calls `startLiveSync()` directly (`api.js:460`), and `_init()` resumes it on reload via `hasSessionToken()`, which accepts either the reg-token or a full session token (`api.js:44`).

**Refresh/update strategy:** Event-driven, not screen-driven. The pending screen itself currently does nothing; the global `handleServerSync()` listener does the work and calls `route()`, which will simply stop rendering `pending` once status changes. My only proposed addition is a **manual "Проверить статус" button** as an explicit, user-initiated fallback (e.g., if a poll tick was lost to a flaky connection, or the user just wants immediate reassurance rather than waiting up to 2s).

**User actions today:** Only "Вернуться на лендинге" (`data-go-home` → `closeExperience()`), which hides the app shell but does **not** log the user out (confirmed: `closeExperience()` does not call `Credo.setCurrentUserId(null)` or `API.logout()`). Re-opening the dashboard will call `route()` again and correctly land back on `pending` (or wherever their status now points) since `startLiveSync()` already resumed on load.

**Edge cases (verified in code, not assumed):**
- *Local demo mode* (`FUNCTIONS_BASE` unset): `Credo.registerUser()` (`credo.js:145-185`) can also produce `status: 'pending'` for the 2nd+ demo account on a device. There is no backend, so live-sync is a no-op (`startLiveSync()` returns immediately if `!FUNCTIONS_BASE`). Status changes only happen synchronously in the same browser (an admin approves via the Users tab), and `route()` re-runs on every demo-account switch, so the screen already reflects reality without any polling being necessary.
- *Reload without `?open=dashboard`*: the SPA shows the landing page by default (`init()` → `setAppVisible(false)`), not the pending screen, until the user re-enters the dashboard experience. This is pre-existing behavior for **every** authenticated screen, not something specific to moderation — I'm not proposing to change it.
- *Logout while pending*: the top demo bar (`#demo-bar`) is shown whenever `_appVisible && currentUser` (`app.js:185`), regardless of admin/approval status, so `#demo-logout-btn` → `handleDemoLogout()` is already reachable from the pending screen and correctly calls `API.logout()` (which clears tokens and stops the sync timer). No gap here.

**Transition after approval:** Automatic, ≤2s, via `handleServerSync()` → `route()` → `setPassword` or `main`.

**Transition after rejection:** Automatic, ≤2s, same mechanism → `route()` → `blocked`.

## 4. Implementation Strategy

Because the functional core already works, I'm proposing the smallest possible additive change, entirely inside the existing pending screen markup/branch — **no new files, no new services, no new database access**:

1. Add a small, muted "last checked" status line and a manual "Проверить статус" button to `#screen-pending`, reusing existing `.btn-outline`/`.hint` styling.
2. Wire the button to call `API.syncNow()` (already exported, already the exact function the 2s timer calls) followed by `route()` — i.e., trigger one sync cycle on demand instead of waiting for the timer.
3. Extend the existing pending-render block in `route()` (`app.js:296-300`) to stamp the last-checked time whenever the screen is (re)shown, so returning to it after a sync event still feels alive.
4. No change to `handleServerSync`, `syncNow`, `startLiveSync`, or any Edge Function — those already do the right thing.

This keeps the change surgical: if the lead developer decides the existing 2-second silent auto-transition is sufficient UX and declines the manual button, **zero code changes are required for this task at all.**

## 5. Required Changes

- **`index.html`** — modify `#screen-pending` (lines 200-210) to add a status line + button. No new section.
- **`app.js`** — modify the `pending` branch inside `route()` (lines 296-300) to stamp last-checked time; add one small new handler function; add one `addEventListener` call inside `init()`.
- **`style.css`** — one small additive rule for the status meta line (everything else reuses `.btn`, `.btn-outline`, `.hint` as-is).
- **New files:** none.
- **New assets:** none.
- **Database/API changes:** none.

## 6. Complete Implementation

### `index.html` (replace lines 200-210)

```html
<section id="screen-pending" class="screen hidden">
  <div class="screen-shell auth-shell">
    <div class="glass-panel status-card">
      <div class="status-icon">...</div>
      <h2>Заявка отправлена</h2>
      <p class="subtitle">Аккаунт <strong id="pending-nickname">@user</strong> ожидает одобрения.</p>
      <p class="hint">После одобрения вы сможете задать пароль и войти как в полноценный мессенджер.</p>
      <p id="pending-sync-meta" class="hint hint-dev">Статус проверяется автоматически каждые несколько секунд.</p>
      <div class="status-actions">
        <button id="pending-refresh-btn" class="btn btn-outline" type="button">Проверить статус</button>
        <button class="btn btn-outline" type="button" data-go-home>Вернуться на лендинг</button>
      </div>
    </div>
  </div>
</section>
```

### `style.css` (additive rule; place near `.status-card` / `.status-icon`, e.g. after line 720)

```css
.status-actions {
  display: grid;
  gap: 10px;
  margin-top: 4px;
}

@media (min-width: 420px) {
  .status-actions {
    grid-auto-flow: column;
    justify-content: center;
  }
}
```

*(`.hint-dev` already exists at `style.css:941-943` and is reused as-is for the muted meta line — no new color token needed.)*

### `app.js` — extend the pending branch inside `route()` (replace lines 296-300)

```javascript
    if (user.status === 'pending') {
      $('#pending-nickname').textContent = `@${user.nickname}`;
      _updatePendingSyncMeta();
      showScreen('pending');
      return;
    }
```

### `app.js` — new small helper (place near other pending-related state, e.g. below the `_pendingPhone` declarations around line 41)

```javascript
  let _pendingCheckInFlight = false;

  function _updatePendingSyncMeta(state) {
    const meta = $('#pending-sync-meta');
    if (!meta) return;

    if (state === 'checking') {
      meta.textContent = 'Проверяем статус...';
      return;
    }

    if (state === 'error') {
      meta.textContent = 'Не удалось проверить статус. Попробуйте ещё раз.';
      return;
    }

    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    meta.textContent = _isBackendMode()
      ? `Статус проверяется автоматически. Последняя проверка: ${time}.`
      : 'Статус обновится сразу после одобрения администратором.';
  }

  async function handlePendingRefresh() {
    if (_pendingCheckInFlight) return;
    _pendingCheckInFlight = true;

    const btn = $('#pending-refresh-btn');
    if (btn) btn.disabled = true;
    _updatePendingSyncMeta('checking');

    try {
      if (_isBackendMode() && typeof API.syncNow === 'function') {
        const result = await API.syncNow();
        if (!result?.ok) {
          _updatePendingSyncMeta('error');
          return;
        }
      }
      route();
    } finally {
      _pendingCheckInFlight = false;
      if (btn) btn.disabled = false;
    }
  }
```

### `app.js` — wire the button inside `init()` (add near the other pending-screen-adjacent wiring, e.g. after the OTP wiring block around line 1961)

```javascript
    // Ручная проверка статуса модерации
    const pendingRefreshBtn = $('#pending-refresh-btn');
    if (pendingRefreshBtn) {
      pendingRefreshBtn.addEventListener('click', handlePendingRefresh);
    }
```

No changes to `handleServerSync`, `syncNow`, `startLiveSync`, `SYNC_EVENT`, or `route()`'s branching order — only the pending branch's body gained one line, and the screen gained a self-contained, idempotent, disable-while-in-flight manual check.

## 7. Architecture Validation

- **Existing architecture**: Follows the same "single `route()` state machine + `showScreen()`" pattern used by every other screen; no parallel routing path introduced.
- **Navigation**: Reuses `data-go-home` convention; the new button is a plain in-place action, not a navigation event, consistent with how `#rate-back-btn` (`app.js:2061`) triggers a same-screen refresh (`refreshAll()`) rather than a screen change.
- **State management**: No new global state beyond one boolean in-flight guard (`_pendingCheckInFlight`), mirroring existing guards like `_syncInFlight` in `api.js:37` and `_typingDebounceTimer` patterns already in `app.js`.
- **Design system**: Zero new colors, zero new fonts — reuses `.btn-outline`, `.hint`, `.hint-dev`, `.status-card` verbatim.
- **Coding conventions**: Function naming (`handlePendingRefresh`, `_updatePendingSyncMeta`) matches existing `handle*`/`_update*` naming used throughout `app.js` (e.g. `handleResendOtp`, `_updateNavBadges`).
- **No duplication**: The button calls the *existing* `API.syncNow()` rather than reimplementing a `/me` fetch, and `route()` is the *existing* transition mechanism — this proposal activates existing plumbing instead of adding a second one.

## 8. Risks

- **UX risk (low):** A manual button next to an already-automatic 2s poll could look redundant or make users wonder why they'd need it. Mitigation: copy explicitly says status updates automatically; button is framed as an optional immediate check, not the only way it happens.
- **UX risk (low):** Local demo mode has no backend concept of "checking" — calling `route()` alone (no `syncNow`) is correct, but the copy needs to clearly differ from backend-mode copy so it doesn't imply a network call that isn't happening. Handled above via `_isBackendMode()` branching, but the exact Russian wording should be reviewed by the lead/native speaker.
- **Navigation risk:** None identified — `route()`'s priority ladder is unchanged; the pending branch's added line only sets text content before `showScreen()`, it cannot alter which screen is chosen.
- **Moderation flow risk:** None — no changes to `approve`/`reject` Edge Functions, RLS, or the `users.status` column. Read-only (`syncNow` → `GET /me`) on manual click, same call the timer already makes.
- **Maintainability risk (low):** Two new small functions in an already very large `app.js` (single-module architecture, pre-existing risk noted in the original project analysis, not introduced by this change).
- **Future scalability risk:** None specific to this screen — if the lead later wants push-based (e.g. Realtime/websocket) approval notifications instead of polling, that would be a separate, larger architectural decision affecting `api.js` broadly, not this screen alone.
- **App Store review risk:** Not applicable — this is a web app, no native submission surface for this screen.

## 9. Questions For The Lead Developer

1. Given the auto-transition already works end-to-end within ~2 seconds, is a manual "Проверить статус" button even wanted, or should this task simply be **closed as already implemented**? I'd lean toward asking before touching any files.
2. Is the exact Russian copy I drafted ("Статус проверяется автоматически...", "Проверяем статус...", etc.) acceptable, or is there a copy owner/style guide I should match instead?
3. Should the pending screen's "Вернуться на лендинг" button also log the user out (clear `credo_current_user`), or is the current "hide app shell, keep session" behavior intentional (so they can resume later without re-registering)? This is pre-existing behavior shared by every authenticated screen, but worth confirming it's intended for `pending` specifically.
4. Is the demo bar's logout button intended to be the production-facing logout affordance for pending/backend users, or is the demo bar meant to be hidden entirely outside of local demo mode (it currently is not gated on `_isBackendMode()`)? This predates this task but surfaced during the flow inspection.
5. Should local-mode "pending" (multi-account demo) even show the "checking automatically" language, or should the manual button be hidden entirely in local mode since there's nothing to poll? My draft already branches copy by `_isBackendMode()`, but the lead may prefer hiding the button outright in local mode instead of relabeling it.
6. Is 2 seconds (`SYNC_INTERVAL` in `api.js:30`) an intentional product decision for this screen, or just an inherited default from the general sync loop? If the lead wants a different cadence specifically while pending (e.g., to reduce load), that's a one-line change but affects the shared timer used by all screens, not just this one — worth a deliberate decision rather than a silent side effect of this task.

## 10. Confidence

| Claim | Basis |
|---|---|
| `#screen-pending` markup and its exact content | Existing source code (`index.html:200-210`) |
| `route()` gating order and pending branch | Existing source code (`app.js:253-313`) |
| Live sync starts on register / resumes on reload | Existing source code (`api.js:460`, `api.js:836-858`, `api.js:44`) |
| `SYNC_EVENT` fired only on real change, consumed by `handleServerSync`, which calls `route()` | Existing source code (`api.js:88`, `app.js:1866-1920`, `app.js:2089-2091`) — **this is a fact, not an assumption; I traced the full call chain** |
| `/me` returns live `status` from `public.users`, no caching | Existing source code (`supabase/functions/me/index.ts`) |
| Approval requires admin role, atomic RPC, applies initial `cred` | Existing source code (`supabase/functions/approve/index.ts`) |
| `logout()` correctly stops the timer and clears both tokens | Existing source code (`api.js:582-595`) |
| Local-mode pending scenario and its resolution path | Existing source code (`credo.js:145-185`) + inference on demo-switch behavior |
| Demo bar visibility regardless of approval status | Existing source code (`app.js:185`, `app.js:145-160`) |
| Proposed copy wording, exact button placement/labels | Inference — needs lead/product review, explicitly flagged in Questions §9.2 |
| Figma design intent for this screen | **Unavailable this session** — Figma MCP is not connected in the current tool set (only `cursor-app-control` and `cursor-ide-browser` are available). Consistent with the earlier finding that no Figma file is referenced anywhere in the repository; I have not approximated any values that should have come from Figma — there is no Figma source for this screen to defer to. |
| Live Supabase schema/RLS re-verification for `users.status` | **Not re-queried this session** — Supabase MCP is not connected in the current tool set. Conclusions above rely on existing Edge Function source code and migration files, which is what actually enforces behavior at runtime; I did not assume anything about live data I couldn't verify. |
| Context7 / official framework docs | Not used — no third-party library or framework API is involved in this change (plain DOM/localStorage patterns already established in the file). |

---

No project files were modified, no commits or branches were created, no SQL was executed, and nothing was deployed. Everything above is a proposal for review — happy to adjust scope (including doing nothing beyond documenting the existing behavior) based on the lead developer's answers to §9.

---

# ORIGINAL RESPONSE 3 of 3 — App Store Connect Submission Package

---

# App Store Connect Submission Package — Fcom Messenger

## Critical blocking finding (read this first)

Before preparing metadata, I verified whether this project can be submitted to App Store Connect at all. **It cannot, in its current form.**

- There is no Xcode project, `.ipa`, native shell, or hybrid wrapper anywhere in the repository (no `.xcodeproj`, `Info.plist`, Capacitor/Cordova config, or WKWebView shell — confirmed by search).
- The project is a static vanilla HTML/CSS/JS single-page web app (`index.html`, `landing.html`, `app.js`, `api.js`, `credo.js`) served directly, backed by Supabase. There is no build tool, no `package.json`, no bundler.
- App Store Connect only accepts a signed iOS binary. **A binary does not exist and nothing in this repo produces one.**

This does not mean the work below is wasted — App Store metadata, privacy label, age rating, and legal-document planning are independent of the wrapper technology and need to happen regardless. But I want to be explicit: **this document is preparation for a submission that has a hard technical prerequisite (deciding on and building an iOS wrapper — e.g. a thin WKWebView/Capacitor shell, or a native rewrite) that has not started.** I raise this as Question #1 in §10 rather than assuming an answer.

Everything below is written as if that prerequisite will be resolved, so the lead developer has the metadata/compliance work ready in parallel — but I did not invent a wrapper strategy, since that's an architectural decision reserved for the lead developer.

**MCP availability this session:** Figma MCP and Supabase MCP are **not connected** in the current tool set (only `cursor-app-control` and `cursor-ide-browser` are available — confirmed via tool discovery). Per the task's own instruction ("if information is unavailable, explicitly state what is missing instead of making assumptions"), every conclusion below that would normally lean on Figma/Supabase MCP is instead based on **existing source code** (Edge Functions, migrations, `index.html`/`credo.js`/`api.js`), and I've labeled each one accordingly in §11. Nothing here was guessed where the code gave a direct answer; where the code doesn't say, I've flagged it as missing rather than filled it in.

---

## 1. App Store Information

| Field | Recommendation | Status |
|---|---|---|
| **App Name** | `Fcom Messenger` (from `index.html:6` `<title>`) or `Fcom — The Digital Universe` (from `landing.html:7` `<title>`). **These two existing titles disagree** — this needs a single decision before submission. | Fact (two conflicting titles found in source) + decision needed |
| **Subtitle** | Not present anywhere in the project. A subtitle (30 chars) needs to be written fresh once the App Name is finalized — I'm not fabricating one since it should reflect actual product positioning the lead has in mind (e.g. school-only vs. general messenger). | Missing |
| **Promotional Text** | Not present. Same reasoning — deferring to avoid inventing marketing claims not reviewed by product owner. | Missing |
| **Description** | No App-Store-ready description exists. `landing.html` contains marketing copy but it's HTML page content, not App Store copy, and I have not verified its accuracy against current features (e.g. it may describe functionality — groups, media — inconsistently with what's live, per the doc-drift issue identified in the original architecture analysis). Recommend drafting the description **after** the wrapper/UGC-compliance gaps in §6/§9 are resolved, so the copy doesn't promise features (or safety guarantees) that aren't true yet. | Deferred — depends on open gaps |
| **Keywords** | Cannot responsibly propose without confirmed category/audience (see §2, §3). Placeholder categories only: messenger, chat, school, students, community — pending confirmation of intended audience. | Deferred |
| **Support URL** | **Missing.** No support page, no contact email, no help center found anywhere in the repo. | Missing — blocking |
| **Marketing URL** | **Missing.** No production domain is configured anywhere (`DEPLOY.md` only shows placeholder examples like `fcom.example.com`; no `vercel.json`/`netlify.toml`/`CNAME` found). | Missing — blocking |
| **Privacy Policy URL** | **Missing.** `landing.html` (and its `.tmp_fcom` prototype copies) contain a "Privacy" link that points to `#0` — a dead placeholder anchor, not a real policy. Apple requires a live, reachable Privacy Policy URL for every submission. | **Missing — hard blocker for submission** |
| **Terms of Service URL** | **Missing.** No ToS document or link found anywhere. | **Missing — blocker** (required for anything with UGC + accounts) |

## 2. Category

**Primary Category recommendation: Social Networking**
The app's core loop is peer messaging, groups, and a peer-rating ("cred") system between real people who register with their real name, school, and grade (`index.html:90-91`, `BACKEND.md:1043`). That is squarely Social Networking, not Utilities or Productivity.

**Secondary Category recommendation: Education** (tentative, needs lead confirmation)
Registration requires `school` and `grade` (Russian "Класс," e.g. "10А" — a K-11 school class notation, confirmed at `index.html:90-91`), and the entire trust/approval model is built around school-scoped peer groups (`BACKEND.md`: "same school" checks throughout the Edge Functions, cross-school RLS isolation). This strongly suggests an education-adjacent audience, which affects category, age rating, and — critically — legal obligations (see §9).

I'm not recommending Education as *primary* because the product's functional surface (chat, groups, ratings) is a social product, not learning content — but the lead developer should confirm whether "Education" secondary category is desired for discoverability, or whether the school angle should be downplayed for App Store purposes.

## 3. Age Rating

Working through Apple's actual questionnaire categories against verified app behavior:

| Questionnaire item | Answer | Basis |
|---|---|---|
| Cartoon or Fantasy Violence / Realistic Violence | None | No such content exists in the product (chat/messaging app). Source code. |
| Sexual Content or Nudity | None built-in, but **unmoderated user photo uploads exist** (`upload-media/index.ts` accepts arbitrary `image/*` files up to 6MB) with **no automated or pre-publication moderation found in the code**. This is a real risk vector, not just a checkbox — see §9. | Source code fact (upload exists) + inference (risk of misuse) |
| Profanity or Crude Humor | Likely "Infrequent/Mild" at minimum — free-text chat between users cannot be assumed profanity-free without a filter, and **no profanity filter or content moderation was found in `messages` Edge Function or `credo.js`.** | Source code (no filter found) |
| Mature/Suggestive Themes | Unknown / cannot rule out — same reasoning: unrestricted free-text + image messaging between users. | Inference from absence of moderation |
| Horror/Fear Themes | None | Source code |
| Gambling / Contests | None found | Source code |
| Medical/Treatment Information | None | Source code |
| Alcohol, Tobacco, Drugs | None built-in, but user-generated chat can't be constrained without moderation. | Inference |
| **Unrestricted Web Access** | No — no embedded browser/arbitrary web content found. | Source code |
| **User-Generated Content** | **Yes** — chat messages, group chat, photo attachments, and a peer-rating system are all UGC (`credo.js`, `messages/index.ts`, `upload-media/index.ts`, `rate/index.ts`). | Source code fact |

**Recommended Age Rating: 17+** is the *safe/conservative* answer given unmoderated free-text chat + unmoderated photo upload with no profanity filter and no automated content scanning — Apple's questionnaire pushes ratings up sharply once "User-Generated Content" is combined with unrestricted messaging and no moderation tooling.

However — **this directly conflicts with the apparent target audience.** The registration flow is explicitly built around school classes ("Класс," grades like "10А"), meaning the actual population using this app is very plausibly composed of minors, likely well under 17. **A 17+ rating on an app whose real audience is school-age children is not a compliant resolution — it's a sign the product needs either (a) real moderation infrastructure before submission, or (b) explicit confirmation from the lead/product owner about who is actually allowed to use it and how that's enforced.** I'm flagging this as the single most important open question in §10 rather than picking a rating that papers over it.

**Missing information:** Apple's questionnaire also asks about "Contests," "Loot boxes," and jurisdiction-specific declarations — none of these apply here, but I could not verify Apple's *current* exact questionnaire wording without Context7/official docs access being needed for a UGC-related guideline confirmation, which I did use conceptually (App Store Review Guideline 1.2 for UGC apps) — this is well-established, stable Apple policy I'm confident citing from training knowledge, but I did not fetch it live this session since Context7 wasn't required for a simple guideline number and no framework-specific API question was involved.

## 4. Privacy Nutrition Label

Based directly on the `users` table columns actually read/written by the Edge Functions (`supabase/functions/me/index.ts:23`, `register/index.ts`, and the field list documented in `BACKEND.md:1043,1259`), plus what the client actually stores:

**Data collected and linked to the user identity:**
- Full name (`fullName`) — collected at registration, required
- Phone number (`phone`) — collected, OTP-verified (`verify-phone`, `resend-otp` Edge Functions)
- School name (`school`) — collected, required, used for access-control isolation
- Grade/class (`grade`) — collected, required
- Nickname/username (`nickname`) — collected, required, publicly visible to other users in the same school
- User-generated content: chat messages (`messages` table/Edge Function), photos (`upload-media`)
- Peer ratings given/received ("cred" score, `rate/index.ts`) — behavioral data about the user, contributed by other users
- Device fingerprint (`deviceFingerprint`, sent at registration per `register/index.ts` and `api.js` `getDeviceFingerprint()`) — used for anti-abuse device blocking (`isDeviceBlocked`), not disclosed to the user anywhere I found
- Avatar image URL (`avatarUrl` column exists in `me` response) — collected if a user sets one

**Data used for app functionality (not analytics):** all of the above — there is no analytics SDK, no tracking pixel, no third-party analytics call found anywhere in the codebase (no Firebase, Segment, Mixpanel, Amplitude, or similar found in any `.js` file). **This is a verified fact, not an assumption** — a full-repo search for common analytics SDK names and `<script src=` tags pointing to third-party analytics domains returned nothing.

**Data used for analytics:** None found. If the lead plans to add analytics later, the label will need to be revisited before that ships — flagging as forward-looking, not a current gap.

**Data optional vs. required at registration:** Based on `index.html`'s registration form and the Edge Function's field validation (`register/index.ts`, `school_required` error in `BACKEND.md:250`), `fullName`, `school`, `grade`, `nickname` appear **required**; `phone` is passed as a parameter with a default empty string in `api.js:426` (`phone = ''`), suggesting it may be **optional** at registration but then gates further flows if provided (`phoneVerified` check in `route()`). This should be confirmed with the lead rather than assumed, since optionality affects the privacy label's "linked/required" distinctions materially.

**What I could NOT verify this session:** the *live* Postgres schema, RLS policies, and whether any columns exist beyond what the Edge Functions expose (e.g., IP address logging, `rate_limit_log` contents, `approval_log` actor tracking) — Supabase MCP is not connected. My conclusions above are limited to what the Edge Function source code reads/writes, which is what actually flows to the client and to third parties (i.e., what matters for the privacy label), but a live schema query would be the authoritative confirmation step before finalizing the nutrition label. I explicitly recommend that as a pre-submission step (§10).

**Third-party data sharing:** None found — Supabase is the only backend, self-hosted-per-project (not itself a "third party" for privacy-label purposes in the way Apple defines it, since it's the developer's own backend infrastructure, not a separate data recipient).

## 5. App Capabilities

| Capability | Status today | Evidence |
|---|---|---|
| **Sign In** | Custom (nickname + password, phone/OTP verification). **No "Sign in with Apple," no Google/Facebook/social OAuth found anywhere** — confirmed by search. Since no third-party social login is offered, Apple's Guideline 4.8 (mandatory Sign in with Apple parity) is **not triggered** — but the lead should confirm no OAuth plans exist before submission, since adding any social login later would require adding Sign in with Apple too. | Source code fact |
| **Notifications** | **In-app only** (toast banners + nav badges via `notifications.js`). **No OS push notifications** — no service worker, no Web Push subscription, no APNs integration found anywhere. If the App Store listing or description implies "push notifications," that would be inaccurate today. | Source code fact |
| **User Generated Content** | Yes — live today: text chat, group chat, photo uploads, peer ratings. | Source code fact |
| **Reporting** | **Not implemented.** Confirmed proposed-only in a prior planning pass (`reports` Edge Function, `user_blocks`/`reports` tables) but **no such files exist in `supabase/functions/` today** (verified: only 16 functions exist, `reports` and `blocks` are not among them). | Source code fact — this is a real, current gap |
| **Blocking** | **Not implemented**, same status as Reporting above. | Source code fact |
| **Moderation** | Only at the **account level**: admin approve/reject of new registrants (`approve`/`reject` Edge Functions), scoped to same school. **No content-level moderation** (no profanity filter, no image scanning, no message reporting) exists. | Source code fact |
| **Location** | Not used anywhere in the app. | Source code fact |
| **Camera** | Indirectly — `upload-media` accepts image uploads; whether the web `<input type="file">` triggers camera capture depends on markup attributes I'd need to re-check per input element, but no native camera API is used (this is a web app, so it's the browser's own file-picker affordance, not a native `AVFoundation` capability). | Source code + inference |
| **Photos** | Yes — photo attachments in chat go through `upload-media`. | Source code fact |
| **Contacts** | Not used — no contacts API/permission access anywhere. | Source code fact |

**The Reporting/Blocking gap is the most consequential item in this table.** Apple's App Store Review Guideline 1.2 (User-Generated Content) explicitly requires apps with UGC and person-to-person communication to include a mechanism to report objectionable content and the ability to block abusive users. This app has neither implemented yet — only proposed. **This alone is very likely to cause App Store rejection** if submitted as-is, independent of the missing native wrapper. See §9.

## 6. Required Legal Documents

| Document | Present? | Evidence |
|---|---|---|
| Privacy Policy | **No.** Only a dead `href="#0"` placeholder link in `landing.html` (and its `.tmp_fcom` prototype duplicates). No actual policy document, page, or text exists in the repo. | Missing — blocker |
| Terms of Service | **No.** No document, page, or link (not even a placeholder) found. | Missing — blocker |
| Account Deletion Policy / in-app deletion flow | **No.** Searched for delete-account functionality across the entire codebase (functions, UI, docs) — nothing found. There is a `logout()` (clears session) but no account/data deletion path anywhere, client or server. Apple Guideline 5.1.1(v) requires apps that support account creation to also offer in-app account deletion. | Missing — blocker (this is a distinct, well-defined Apple requirement, not a general inference) |
| Community Guidelines | **No.** No such document exists. Given the school-scoped, minors-plausible audience and the missing Report/Block tooling, this is a meaningful gap beyond just "nice to have." | Missing |

All four required documents are absent. None of these can be fabricated responsibly on the app's behalf — they require product/legal decisions (data retention period, jurisdiction, minors' data handling under things like COPPA/GDPR-K if applicable) that are the lead developer's/product owner's to make, especially given the apparent school/minors audience.

## 7. Required Screenshots

I want to flag upfront: I could not use Figma as source-of-truth for this section (Figma MCP not connected this session, and — consistent with earlier findings in this project — no Figma file is referenced anywhere in the repository at all). Recommendations below are based on the actual implemented screens in `index.html`/`app.js`, not a design source.

Recommended order and content (based on real, existing screens):

1. **Landing/hero** — from `landing.html`'s hero section — sets product identity before showing the app itself.
2. **Registration** — shows the school/grade-based signup, communicates the "who this is for" story honestly.
3. **Main chat list** (`#screen-main`, chats tab) — the core value prop.
4. **Active chat conversation** — demonstrates the messaging UX and (if approved for display) photo attachment.
5. **Members/participants tab** — shows the community/school-scoped discovery aspect.
6. **Profile screen** with settings entry point — shows account control surface (especially important once Settings/notifications-toggle work, from the earlier proposal, ships).

**Devices required:** iPhone 6.9" and 6.5" display screenshots are mandatory for current App Store Connect submissions; iPad screenshots are only required if the app supports iPad. Since there is no native app yet, device-specific screenshot sizing can't be finalized until the wrapper strategy (§ blocking finding) is decided — a WKWebView-based iPhone-only wrapper vs. a responsive iPad-capable one changes this requirement set.

**App Preview (video):** Optional, not required. Given the product is fundamentally a messenger, a 15-30s preview showing register → get approved → chat could work well, but I'd recommend shipping static screenshots first and treating video as a fast-follow, not a blocker.

I'm deliberately not inventing exact pixel dimensions or mock screenshot copy — that's a design/production task, not something to guess at without the actual visual source.

## 8. App Review Notes

Draft notes for Apple's review team (to be refined once the gaps above are closed):

> This app is a school-community messenger. New users register with their name, school, and class, and must be approved by an existing approved member of the same school before gaining access (see in-app "Заявка отправлена / Application submitted" pending screen). This is currently the only moderation gate — please note that message-level reporting and user-blocking are [in development / not yet available — update once §9 gaps are resolved].

**Moderation workflow to disclose:** account-level approval only, admin/peer-approved, scoped per school (`approve`/`reject` Edge Functions, `role = 'admin'` gate confirmed in `approve/index.ts:64`).

**Test account requirements:** Apple will need a working demo account that is already `status = 'approved'` with a password set, to reach the main chat experience without needing a second approver account. Given the "first user per school is auto-approved" behavior noted in `BACKEND.md:545` (via `auto_approve_first`) — **this was previously flagged in the original project audit as possibly a no-op in the live database**, so this must be re-verified against the actual production Supabase project (I cannot verify this myself this session — Supabase MCP unavailable) before relying on it to bootstrap a reviewer account.

**Special instructions:** Given the school-scoped registration requires a real school name and grade, reviewers may need explicit sample values to enter (e.g., "Школа №1" / "10А", visible as placeholder examples in `BACKEND.md`) since these aren't obviously arbitrary to an outside reviewer.

**Login information:** A pre-approved demo nickname + password pair must be provided in the App Review login fields — cannot be generated without backend access, this must come from the lead developer directly.

## 9. Risks

**App Store Review risks (high):**
- No native binary exists yet — nothing to submit today.
- Missing Report/Block for a UGC + direct-messaging app — likely rejection under Guideline 1.2.
- Missing in-app account deletion — likely rejection under Guideline 5.1.1(v).
- Missing Privacy Policy URL — hard requirement, submission cannot even be configured in App Store Connect without one.
- Age rating vs. actual (likely underage) audience mismatch — could trigger deeper review scrutiny or rejection under Apple's Kids Category/minors-safety policies if reviewers infer the real audience from the registration flow (school class field is a strong signal).

**Privacy risks (high):**
- Real name + phone number + school + grade collected together is a highly identifying combination for what may be a minor population — this significantly raises the bar for what "adequate" privacy protection looks like, well beyond a generic privacy policy template.
- Device fingerprinting is collected for anti-abuse purposes but (as far as I could verify from source) is not disclosed to the user anywhere in the UI — this needs to be reflected honestly in the privacy policy once written.
- No confirmed data retention/deletion story (ties to missing account deletion flow).

**Missing compliance items:** Privacy Policy, Terms of Service, Account Deletion, Community Guidelines, Report, Block — all listed in §6/§5, all currently absent.

**Legal risks:** If the real user base includes minors under 13 (plausible given "Класс" grade levels starting as low as grade 1), COPPA (US) or equivalent minors'-data regulations may apply depending on jurisdiction and hosting/target market — this is a legal determination, not something I can resolve technically, and I'm flagging it rather than guessing a compliance posture.

**Product risks:** Shipping a direct-messaging + photo-upload product to a school-age audience without any reporting/blocking or content moderation is a real user-safety risk independent of App Store compliance — this is worth the lead's attention regardless of the submission timeline.

## 10. Questions For The Lead Developer

1. **Is there a decided strategy for producing an actual iOS binary** (native rewrite, WKWebView shell, Capacitor/Cordova, or something else)? Nothing in the repo indicates a direction, and this blocks everything else in this package from becoming real.
2. **Who is the actual, intended audience?** The registration flow (school + Russian school-class field) strongly implies K-11 students, but nothing in the project explicitly states an age policy or minimum-age enforcement. This single answer changes the Age Rating, Category, Privacy Policy content, and legal risk profile more than anything else in this document.
3. Is `auto_approve_first` (first user per school auto-approved) actually functioning in the live production database? The prior architecture audit flagged this as possibly a no-op — this affects how an App Review test account gets bootstrapped.
4. Which app name is correct — "Fcom Messenger" (`index.html`) or "Fcom — The Digital Universe" (`landing.html`)?
5. Are Report/Block/content moderation planned before submission, or is account-approval-only moderation considered acceptable for launch? (Given §9, I'd recommend the former, but this is the lead's call.)
6. Is there an existing Privacy Policy / Terms of Service drafted outside this repository (e.g., by legal counsel) that just hasn't been wired in yet, or does this need to be authored from scratch?
7. Should I (or someone) verify the live Supabase schema directly (columns, RLS, any analytics/logging tables) before finalizing the Privacy Nutrition Label? I could not do this myself this session since Supabase MCP isn't connected.
8. Is there a Figma file for this product that simply isn't linked in the repository, which could serve as the source of truth for App Store screenshots and branding? Every prior task in this engagement has independently confirmed no Figma reference exists in-repo — worth a direct answer rather than continuing to infer "no."
9. Does the device-fingerprint-based anti-abuse mechanism need explicit user-facing disclosure, and is there a data retention period defined for it?
10. Is a support email/URL and a real production domain already reserved, just not yet wired into the codebase?

## 11. Confidence

| Conclusion | Basis |
|---|---|
| No native iOS project/wrapper exists | Existing source code (repo-wide search, no `.xcodeproj`/Capacitor/Cordova artifacts) |
| Conflicting app names ("Fcom Messenger" vs. "Fcom — The Digital Universe") | Existing source code (`index.html:6`, `landing.html:7`) |
| Privacy Policy / Terms links are placeholders (`#0`) | Existing source code (`landing.html:1599` and `.tmp_fcom` duplicates) |
| No account deletion flow anywhere | Existing source code (repo-wide search, no matches) |
| Report/Block not implemented (proposal-only) | Existing source code (`supabase/functions/` directory listing — 16 functions, none named `reports`/`blocks`) |
| Only account-level (not content-level) moderation exists | Existing source code (`approve`/`reject` Edge Functions; no profanity/image-moderation code found) |
| No push notifications, no analytics SDK | Existing source code (repo-wide search for service workers, Push API, common analytics SDK names — no matches) |
| School/grade-based registration implies a minors-heavy audience | Existing source code (`index.html:90-91` "Класс" field with "10А" placeholder) — **fact** that the field exists; **inference** that this necessarily means the real-world audience is minors (strong signal, not textbook proof) |
| Recommended 17+ age rating given current moderation gaps | Inference, applying Apple's documented UGC/moderation rating logic (general policy knowledge) to the verified facts above — **explicitly flagged as being in tension with the likely real audience**, not a clean recommendation |
| Guideline 1.2 (Report/Block requirement) and 5.1.1(v) (account deletion requirement) citations | General knowledge of stable, long-standing Apple App Store Review Guidelines — not re-verified via Context7 this session since no version-specific or ambiguous API detail was in question, only a well-known, stable policy number |
| Privacy nutrition label data categories | Existing source code (`me`, `register`, `upload-media`, `rate` Edge Functions + `BACKEND.md` field tables) — **explicitly incomplete** without a live Supabase schema check, which I could not perform (MCP unavailable) |
| No production domain configured | Existing source code (`DEPLOY.md` placeholder examples only; no `vercel.json`/`netlify.toml`/`CNAME`) |
| Figma design/branding source | **Unavailable** — Figma MCP not connected this session; consistent with every prior task in this engagement finding no Figma file referenced in the repository |
| Live Supabase schema/RLS/analytics tables beyond what Edge Functions expose | **Unavailable** — Supabase MCP not connected this session; conclusions limited to Edge Function source code, explicitly flagged as needing live confirmation |

---

No project files were modified, no commits or branches were created, nothing was submitted or published, and no database was queried or changed. This is a readiness assessment and planning document only — several sections (App Name, Description, Keywords, Screenshots, Support/Marketing URLs) are intentionally left as open decisions rather than filled with placeholder content, since fabricating them would misrepresent facts the lead developer and product owner haven't decided yet.