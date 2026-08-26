## 1. Understanding

The app is a single-page vanilla JS app where every screen is a `.screen` `<section>` inside `#app-shell` (`index.html`), toggled by `App.showScreen()` (an object lookup + `hidden` class swap, `app.js` lines 20-31, 176-193). Sub-screens that hang off another screen (e.g. `#screen-user-profile`, `#screen-rate`) follow a consistent "open/close" pair of functions that render content into static DOM, then call `showScreen()`; the "back" action either calls a dedicated `close*()` function or `refreshAll()`.

Settings does not exist today. The closest analogous existing screen is `#screen-user-profile` / `openUserProfile()` / `closeUserProfile()` — a screen reached from elsewhere in the app, showing a read-only profile summary, with a "Назад" button that returns to a remembered origin. I'm modeling Settings directly on this pattern rather than introducing a new navigation concept.

There is **no existing bottom-nav-tab candidate slot** for Settings (the nav has exactly 4 fixed items: Чаты/Участники/Профиль/Админ, `index.html` lines 225-240), so — consistent with the recommendation from the prior implementation plan — Settings is implemented as a screen reached **from the Profile tab** via a small button, not a 5th nav tab. This avoids any navigation-architecture change.

Scope decision (see confidence/questions below): I'm shipping the zero-backend-risk subset of "Settings" — read-only account summary, a local notification toggle, and logout — because that is the only subset that can be built entirely by reusing existing services/state with no new Edge Function, no new Supabase table, and no RLS change, matching "never redesign, refactor or replace existing systems." Anything requiring a backend write (editable profile fields, cross-device preferences) is explicitly left out and flagged as a question.

## 2. Reused Project Assets

**Components**
- `.screen` / `.screen-shell` scaffold — every screen uses this (`index.html`, `style.css` lines 620-632).
- `.pane-shell` / `.pane-head` — used identically in `#screen-rate`, `#tab-admin`, etc.
- `.user-profile-head` — the avatar+name row markup already used in `#tab-profile` and `#screen-user-profile`.
- `.user-profile-actions` — the exact existing button-row class from `#screen-user-profile` (`user-profile-actions { display:flex; gap:10px }`, `style.css` line 1599), reused verbatim for the new "Настройки" entry button — **zero new CSS** for that button.
- `.group-member-option` — the existing checkbox+label row component from the group-invite picker (`style.css` line 1801), reused for the notification toggle row.
- `Avatar.html()` (`avatars.js`) — for the account avatar.

**Services**
- `Credo.getUserById` / `Credo.getCurrentUserId` (`credo.js`) — reading the current user.
- `API.logout()` via the existing `handleDemoLogout()` function (`app.js` line 1819) — this is already the real logout implementation used by the persistent top bar's "Выйти" button; I call it directly rather than duplicating logout logic.
- `Notif` (`notifications.js`) — untouched; only its call-site in `app.js` gets one added condition.

**Navigation**
- `App.showScreen()` / the `screens` lookup object — extended with one new entry, no change to the routing mechanism (`route()`, `showTab()` untouched).
- The `openX()`/`closeX()` pair convention from `openUserProfile()`/`closeUserProfile()` (`app.js` lines 1088-1155), reused for `openSettings()`/`closeSettings()`, including reusing `closeUserProfile()`'s exact "return to main + reopen a specific tab" logic.

**Design tokens**
- All colors/radii/shadows come from existing `:root` variables and existing component classes — no new custom properties.

**Utilities**
- `escapeHtml()` is not needed here since no HTML is built from user-controlled strings via `innerHTML` on this screen — all Settings content is written via `textContent` or static markup, consistent with how `_renderProfileContent()` already does for name/school/grade fields (`app.js` line 913-914).

**Models**
- No new model. The user object (`credo_users`) already has everything needed (`fullName`, `nickname`, `school`, `grade`, `avatarUrl`). One new local-only preferences model is introduced (see below) — not a new file, just two new functions on the existing `Credo` module, following its existing simple-getter/setter convention (e.g. `getDeviceAccountIds`/`markDeviceAccount`).

## 3. Implementation Strategy

1. **New screen, not a new tab.** Add `#screen-settings` as a sibling of `#screen-rate`/`#screen-user-profile` in `index.html`, and one entry in `app.js`'s `screens` map.
2. **Entry point:** one small `.btn.btn-outline.btn-small` "Настройки" button added inside the existing Profile-tab `.profile-card`, wrapped in the already-existing `.user-profile-actions` class (no new CSS).
3. **Three stacked `.pane-shell` sections** inside the new screen: Account (read-only summary), Notifications (one local toggle), Session (logout). This mirrors how `#tab-admin` stacks multiple `.pane-shell` blocks.
4. **One new CSS rule**, added to the *existing* shared grid-selector group (`.tab-content, .users-grid, .profile-grid, .admin-summary-grid`) rather than a standalone new block, plus one small override — following the exact pattern already used for `.admin-summary-grid`.
5. **Local-only preference storage.** A `notificationsEnabled` boolean, per user, stored under a new `credo_settings` localStorage key via two new `Credo` functions (`getNotificationsEnabled`/`setNotificationsEnabled`), following the file's own `loadJSON`/`saveJSON` convention. No `api.js` change, no Edge Function, no migration — this preference intentionally does **not** sync across devices, since introducing server-sync here would mean patching `_syncCurrentUser()`/adding an Edge Function call, which is exactly the kind of new backend surface this task's low-risk scope excludes (see Question 2 below).
6. **One line changed** in `renderMainScreen()` to gate the existing `Notif.checkAndNotify()` call on the new preference — the notification *engine* itself (`notifications.js`) is untouched.
7. **Logout reuses `handleDemoLogout()` directly** — no new logout logic.

No new files are created. All changes are additive edits to `index.html`, `app.js`, `credo.js`, and `style.css`.

## 4. Required Changes

**Existing files that would change:**
- `index.html` — new `#screen-settings` section; new button inside `#tab-profile`'s `.profile-card`.
- `app.js` — new `screens.settings` entry; new `renderSettingsScreen()`, `openSettings()`, `closeSettings()` functions; new event wiring in `init()`; one-line gating change in `renderMainScreen()`.
- `credo.js` — new `getSettings()`, `getNotificationsEnabled()`, `setNotificationsEnabled()` functions; add `credo_settings` cleanup to `resetAll()`; add new keys/exports.
- `style.css` — add `.settings-grid` to the existing shared grid selector + one override rule.

**New files:** None.

**Assets:** None.

**Database changes:** None.

**API changes:** None.

**Navigation changes:** One new reachable screen (`settings`), entered only from the Profile tab; no change to `route()`, bottom-nav, or any existing screen transition.

## 5. Complete Implementation

### `index.html` — new entry-point button in the Profile tab

Existing anchor:

```328:351:index.html
            <section id="tab-profile" class="tab-pane hidden">
              <div class="profile-grid">
                <div class="profile-card novice">
                  <div class="user-profile-head">
                    <div id="profile-avatar"></div>
                    <div>
                      <h3 id="profile-fullname">Имя</h3>
                      <p id="profile-info" class="subtitle">@nickname · school · class</p>
                    </div>
                  </div>
                  <div class="cred-display">
                    <div id="profile-cred-value" class="cred-big-value novice">0</div>
                    <div id="profile-cred-level" class="cred-level-label novice">Novice</div>
                    <div class="cred-bar-wrap">
                      <div id="profile-cred-bar" class="cred-bar novice"></div>
                    </div>
                    <div class="cred-bar-labels">
                      <span>Novice</span>
                      <span>Known</span>
                      <span>Trusted</span>
                      <span>Own</span>
                    </div>
                  </div>
                </div>
```

Insert immediately after the `.cred-display` closing `</div>` (before the `.profile-card` closes):

```html
                  <div class="user-profile-actions">
                    <button id="open-settings-btn" class="btn btn-outline btn-small" type="button">Настройки</button>
                  </div>
```

### `index.html` — new `#screen-settings` section

Insert as a new sibling section, right after `#screen-rate` closes (i.e. immediately before the final `</div>` that closes `#app-shell`, line 513):

```html
    <section id="screen-settings" class="screen hidden">
      <div class="screen-shell">
        <div class="settings-grid">
          <div class="pane-shell">
            <div class="pane-head">
              <div>
                <h3>Настройки</h3>
                <p class="subtitle">Аккаунт, уведомления и сессия на этом устройстве.</p>
              </div>
              <button id="settings-back-btn" class="btn btn-outline btn-small" type="button">Назад</button>
            </div>

            <div class="user-profile-head">
              <div id="settings-avatar"></div>
              <div>
                <h3 id="settings-fullname">Имя</h3>
                <p id="settings-info" class="subtitle">@nickname · school · class</p>
              </div>
            </div>
          </div>

          <div class="pane-shell">
            <div class="pane-head">
              <div>
                <h3>Уведомления</h3>
                <p class="subtitle">Хранится только на этом устройстве.</p>
              </div>
            </div>
            <label class="group-member-option">
              <input id="settings-notifications-toggle" type="checkbox" checked>
              <span>Показывать уведомления о новых заявках на вступление</span>
            </label>
          </div>

          <div class="pane-shell">
            <div class="pane-head">
              <div>
                <h3>Сессия</h3>
                <p class="subtitle">Управление входом в аккаунт на этом устройстве.</p>
              </div>
            </div>
            <button id="settings-logout-btn" class="btn btn-danger btn-block" type="button">Выйти из аккаунта</button>
          </div>
        </div>
      </div>
    </section>
```

### `style.css` — one shared-selector extension + one override

Existing anchor:

```1140:1150:style.css
.tab-content,
.users-grid,
.profile-grid,
.admin-summary-grid {
  display: grid;
  gap: 20px;
}

.admin-summary-grid {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}
```

Change to:

```css
.tab-content,
.users-grid,
.profile-grid,
.admin-summary-grid,
.settings-grid {
  display: grid;
  gap: 20px;
}

.admin-summary-grid {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.settings-grid {
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
}
```

### `credo.js` — local, per-user preferences

Existing anchor (function to extend/insert near):

```106:114:credo.js
  function updateUser(id, patch) {
    const users = getUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    Object.assign(users[idx], patch);
    saveUsers(users);
    return users[idx];
  }

  // --------------- Уникальный ID ---------------
```

Insert a new section right after `updateUser` (before "Уникальный ID"):

```js
  // --------------- Настройки (локальные, per-device) ---------------
  // credo_settings — JSON-объект { [userId]: { notificationsEnabled } }
  // Хранится только на этом устройстве — не синхронизируется с backend.

  function getSettings(userId) {
    const all = loadJSON('credo_settings', {});
    return all[userId] || {};
  }

  function getNotificationsEnabled(userId) {
    return getSettings(userId).notificationsEnabled !== false; // включено по умолчанию
  }

  function setNotificationsEnabled(userId, enabled) {
    if (!userId) return;
    const all = loadJSON('credo_settings', {});
    all[userId] = { ...(all[userId] || {}), notificationsEnabled: Boolean(enabled) };
    saveJSON('credo_settings', all);
  }

```

Update `resetAll()` to also clear the new key:

```541:553:credo.js
  // --------------- Полный сброс (для демо) ---------------

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
  }
```

```js
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
    localStorage.removeItem('credo_settings');
  }
```

Update the public API export:

```557:611:credo.js
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
```

Add, e.g. right after `blockDevice,`:

```js
    // Настройки
    getSettings,
    getNotificationsEnabled,
    setNotificationsEnabled,
```

Update the file's header doc comment (accuracy only, matches the file's own convention of listing its localStorage keys):

```1:11:credo.js
/**
 * credo.js — Ядро системы «Кредо» (уровень доверия)
 *
 * Все данные хранятся в localStorage.
 * Ключи:
 *   credo_users        — JSON-массив пользователей
 *   credo_rate_log     — JSON-массив всех оценок
 *   credo_chats        — JSON-объект { "u1::u2": [...messages] }
 *   credo_blocked      — "true" если устройство заблокировано
 *   credo_current_user — id текущего пользователя
 */
```

```js
/**
 * credo.js — Ядро системы «Кредо» (уровень доверия)
 *
 * Все данные хранятся в localStorage.
 * Ключи:
 *   credo_users        — JSON-массив пользователей
 *   credo_rate_log     — JSON-массив всех оценок
 *   credo_chats        — JSON-объект { "u1::u2": [...messages] }
 *   credo_blocked      — "true" если устройство заблокировано
 *   credo_current_user — id текущего пользователя
 *   credo_settings     — JSON-объект { [userId]: { notificationsEnabled } }, локально на устройстве
 */
```

### `app.js` — screens map

```20:31:app.js
  const screens = {
    setPassword:  $('#screen-set-password'),
    login:        $('#screen-login'),
    blocked:      $('#screen-blocked'),
    register:     $('#screen-register'),
    pending:      $('#screen-pending'),
    main:         $('#screen-main'),
    rate:         $('#screen-rate'),
    chat:         $('#screen-chat'),
    verifyPhone:  $('#screen-verify-phone'),
    userProfile:  $('#screen-user-profile'),
  };
```

```js
  const screens = {
    setPassword:  $('#screen-set-password'),
    login:        $('#screen-login'),
    blocked:      $('#screen-blocked'),
    register:     $('#screen-register'),
    pending:      $('#screen-pending'),
    main:         $('#screen-main'),
    rate:         $('#screen-rate'),
    chat:         $('#screen-chat'),
    verifyPhone:  $('#screen-verify-phone'),
    userProfile:  $('#screen-user-profile'),
    settings:     $('#screen-settings'),
  };
```

### `app.js` — gate the existing approval-toast trigger on the new preference

```473:479:app.js
    // Обновить badges и проверить новые события
    _updateNavBadges(user);
    if (_isAdmin(user) && typeof Notif !== 'undefined') {
      Notif.checkAndNotify(user, () => showTab('users'));
    }
  }
```

```js
    // Обновить badges и проверить новые события
    _updateNavBadges(user);
    if (_isAdmin(user) && typeof Notif !== 'undefined' && Credo.getNotificationsEnabled(user.id)) {
      Notif.checkAndNotify(user, () => showTab('users'));
    }
  }
```

### `app.js` — new render/open/close functions

Insert right after `closeUserProfile()` (line 1155), before the `// --------------- Экран чата (имитация) ---------------` comment:

```1134:1157:app.js
  function closeUserProfile() {
    const returnState = _profileReturnState;
    currentProfileUser = null;
    _profileReturnState = null;

    if (returnState?.type === 'chat') {
      showScreen('chat');
      return;
    }

    if (returnState?.type === 'main') {
      const me = Credo.getUserById(Credo.getCurrentUserId());
      if (me) {
        showScreen('main');
        renderMainScreen(me);
        showTab(returnState.tab || 'profile');
        return;
      }
    }

    refreshAll();
  }

  // --------------- Экран чата (имитация) ---------------
```

```js
  // --------------- Экран настроек ---------------

  function renderSettingsScreen(user) {
    const avatarBox = $('#settings-avatar');
    if (avatarBox) {
      avatarBox.innerHTML = Avatar.html({
        seed: user.nickname,
        imageUrl: user.avatarUrl || '',
      });
    }

    $('#settings-fullname').textContent = user.fullName;
    $('#settings-info').textContent = `@${user.nickname} · ${user.school} · ${user.grade}`;

    const notifToggle = $('#settings-notifications-toggle');
    if (notifToggle) {
      notifToggle.checked = Credo.getNotificationsEnabled(user.id);
    }
  }

  function openSettings() {
    const user = Credo.getUserById(Credo.getCurrentUserId());
    if (!user) return;
    renderSettingsScreen(user);
    showScreen('settings');
  }

  function closeSettings() {
    const me = Credo.getUserById(Credo.getCurrentUserId());
    if (me) {
      showScreen('main');
      renderMainScreen(me);
      showTab('profile');
      return;
    }
    route();
  }

```

### `app.js` — event wiring in `init()`

```2036:2039:app.js
    $('#user-profile-back-btn').addEventListener('click', closeUserProfile);
    $('#chat-attach-btn').addEventListener('click', () => $('#chat-image-input').click());
    $('#chat-image-input').addEventListener('change', handleChatImagePick);
    $('#chat-attachment-clear').addEventListener('click', _clearPendingChatImage);
```

```js
    $('#user-profile-back-btn').addEventListener('click', closeUserProfile);

    // Настройки
    $('#open-settings-btn').addEventListener('click', openSettings);
    $('#settings-back-btn').addEventListener('click', closeSettings);
    $('#settings-logout-btn').addEventListener('click', handleDemoLogout);
    $('#settings-notifications-toggle').addEventListener('change', (event) => {
      const userId = Credo.getCurrentUserId();
      if (userId) Credo.setNotificationsEnabled(userId, event.target.checked);
    });

    $('#chat-attach-btn').addEventListener('click', () => $('#chat-image-input').click());
    $('#chat-image-input').addEventListener('change', handleChatImagePick);
    $('#chat-attachment-clear').addEventListener('click', _clearPendingChatImage);
```

That is the complete diff — no other files are touched.

## 6. Architecture Validation

- **Architecture:** No new architectural concept introduced. Settings is a `.screen` in the same flat `screens` map every other screen uses, navigated with the same `showScreen()`/`open*()`/`close*()` convention as `#screen-user-profile`. State is read from the same `Credo`/localStorage source of truth the rest of the app uses; nothing bypasses `credo.js`.
- **Coding conventions:** Function naming (`openX`/`closeX`/`renderXScreen`), Russian UI copy, `$('#id')` DOM access, `'use strict'`-module style, and comment-banner sectioning (`// --------------- ... ---------------`) all match the surrounding code exactly.
- **Design system:** Zero new visual primitives — every element uses an existing class (`.pane-shell`, `.pane-head`, `.btn` variants, `.group-member-option`, `.user-profile-actions`, `.user-profile-head`). Only one new CSS rule was added, and it was added to an *existing* shared-selector group rather than as a standalone block, matching how `.admin-summary-grid` was previously added to that same group.
- **Navigation:** No change to `route()`, `showTab()`, or the bottom nav's 4 fixed tabs. Settings is reachable only via one explicit button and returns to a specific, correct place (`main` + `profile` tab), reusing `closeUserProfile()`'s own "return to a specific tab" logic rather than the less-precise `refreshAll()` pattern used by `#rate-back-btn`.
- **State management:** The one new piece of state (`notificationsEnabled`) is stored exactly like every other simple flag in this codebase — a `loadJSON`/`saveJSON` pair on `Credo`, not a new storage mechanism, not routed through `api.js` (since it's intentionally local-only).

## 7. Risks

- **Technical risks:** Low. Pure additive DOM/localStorage change; no async calls, no new network surface, nothing that can throw during `init()` if elements are missing (all new selectors are guaranteed to exist once the HTML change ships).
- **UI risks:** The "Настройки" button is squeezed into `.profile-card` next to the cred bar — on very narrow viewports this card is already dense (avatar, name, cred display); worth a quick visual check on mobile widths before merging. The logout button uses `.btn-danger`, matching the existing "Отклонить"/"Сбросить" danger-button convention, but logging out isn't destructive the way those actions are — a plain `.btn-outline` might communicate severity more accurately; flagged as a design call for the lead developer rather than decided unilaterally.
- **Maintainability risks:** `handleDemoLogout` is now called from two independent UI locations (the demo bar and Settings) despite its name implying "demo-only" — the name is now misleading. No behavior change is needed, but a future rename (e.g. to `handleLogout`) would improve clarity; I did not rename it here since that would touch an existing exported call site outside this task's scope.
- **Future integration risks:** If a real "edit profile" or "server-synced preferences" feature is added later (per the earlier implementation plan's task list), it will need to extend `_syncCurrentUser()`/add an Edge Function — today's local-only `credo_settings` key does not need to move, but any future *account-level* (not device-level) setting should not be bolted onto this same key without revisiting the sync model.

## 8. Questions For The Lead Developer

1. Is the scoped-down feature set (read-only account summary + one local notification toggle + logout) an acceptable first slice of "Settings," or was a specific different set of settings expected (password change, avatar upload, language, delete account)? Each of those needs backend work not included here.
2. Should the notification preference sync across devices (via a new Edge Function / `users` column) instead of being device-local? I chose device-local specifically to avoid any backend/RLS change in this pass.
3. Is `.btn-danger` the right visual treatment for "Выйти из аккаунта," or should it be a neutral `.btn-outline` like the persistent top-bar's existing logout button?
4. Should "Сбросить все данные" (the existing demo-wide localStorage wipe) be exposed anywhere in this user-facing Settings screen? I deliberately left it out as too destructive/scoped-for-demo to expose to real users — please confirm that's correct.
5. Long-term, should `handleDemoLogout` be renamed now that it's a real, non-demo-only entry point, or left as-is to minimize this diff?

## 9. Confidence

| Decision | Basis |
|---|---|
| Screen/navigation pattern (`screens` map, `open*/close*`, `showScreen`) | Existing source code (`app.js`) |
| Entry point placement (Profile tab, not a 5th nav tab) | Existing source code (fixed 4-item `.bottom-nav`) + Inference (carried over from the prior implementation plan's own recommendation) |
| Reused classes (`.pane-shell`, `.user-profile-actions`, `.group-member-option`, etc.) | Existing source code (`style.css`) |
| Logout reusing `handleDemoLogout` | Existing source code (`app.js`, `api.js`) |
| `credo_settings` local-only storage design | Existing source code convention (`loadJSON`/`saveJSON`, `credo_device_accounts` pattern) + Inference (this specific key/shape is new) |
| Exact settings included (account summary, notification toggle, logout only) | Inference — scoped to what's buildable with zero backend risk, consistent with the earlier plan's own recommendation |
| Figma as source of truth for spacing/typography/hierarchy | **Not applied** — no Figma file reference exists anywhere in this repository, and I did not guess a file key. Confirmed again in this turn; unchanged from the earlier analysis. |
| Context7 | Not applicable — no third-party library/framework is involved in this screen. |
| Supabase MCP | Deliberately not queried for this task — per your instruction to "only inspect backend resources if this screen depends on backend functionality," and this screen has none. |