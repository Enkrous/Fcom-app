'use strict';

/**
 * api.js — Bridge between UI (app.js / credo.js) and Supabase backend.
 *
 * MODES:
 *
 *   LOCAL MODE  (SUPABASE_URL = ''):
 *     All reads/writes go through Credo.* (localStorage).
 *     Identical to the original demo behaviour — no backend required.
 *
 *   BACKEND MODE (SUPABASE_URL filled in):
 *     API.register / API.login / API.setPassword → fetch to Edge Functions.
 *     Credo.approveUser / rejectUser / rateUser / sendMessage are monkey-patched:
 *       they still update localStorage immediately (synchronous, so app.js works
 *       unchanged) and also fire the matching backend call as a side-effect.
 *     On login and on page-load, all server data is synced into localStorage so
 *     every Credo.* read method continues to work without modification.
 *
 * Loading order in index.html: credo.js → api.js → app.js
 * api.js patches Credo before app.js initialises, so all calls are intercepted.
 */

const API = (() => {

  // ─── CONFIGURATION ────────────────────────────────────────────────
  const SUPABASE_URL   = 'https://vzjlhiqvfgrrlfdgyebx.supabase.co';
  const FUNCTIONS_BASE = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : null;
  const SYNC_EVENT     = 'fcom:server-sync';
  const SYNC_INTERVAL  = 2000;

  // ─── TOKEN STORAGE ────────────────────────────────────────────────
  const TOKEN_KEY              = 'fcom_token';          // long-lived session JWT (after login)
  const REG_TOKEN_KEY          = 'fcom_reg_token';      // 1-hour JWT returned after /register
  const TOKEN_MAP_KEY          = 'fcom_account_tokens'; // { [userId]: sessionJwt }
  const ACTIVE_TOKEN_USER_KEY  = 'fcom_token_user';     // userId bound to TOKEN_KEY

  let _syncTimer = null;
  let _syncInFlight = null;
  let _origSendMessage = null;

  function getToken()     { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t)    { t ? localStorage.setItem(TOKEN_KEY, t)     : localStorage.removeItem(TOKEN_KEY); }
  function getRegToken()  { return localStorage.getItem(REG_TOKEN_KEY); }
  function setRegToken(t) { t ? localStorage.setItem(REG_TOKEN_KEY, t) : localStorage.removeItem(REG_TOKEN_KEY); }
  function hasSessionToken() { return Boolean(getToken() || getRegToken()); }

  function _loadTokenMap() {
    try {
      const raw = localStorage.getItem(TOKEN_MAP_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function _saveTokenMap(map) {
    const entries = Object.entries(map || {}).filter(([, token]) => typeof token === 'string' && token);
    if (entries.length === 0) {
      localStorage.removeItem(TOKEN_MAP_KEY);
      return;
    }
    localStorage.setItem(TOKEN_MAP_KEY, JSON.stringify(Object.fromEntries(entries)));
  }

  function getTokenForUser(userId) {
    if (!userId) return null;
    const token = _loadTokenMap()[userId];
    return typeof token === 'string' && token ? token : null;
  }

  function setTokenForUser(userId, token) {
    if (!userId || !token) return;
    const tokens = _loadTokenMap();
    if (tokens[userId] === token) return;
    tokens[userId] = token;
    _saveTokenMap(tokens);
  }

  function removeTokenForUser(userId) {
    if (!userId) return;
    const tokens = _loadTokenMap();
    if (!(userId in tokens)) return;
    delete tokens[userId];
    _saveTokenMap(tokens);
  }

  function getActiveTokenUserId() {
    return localStorage.getItem(ACTIVE_TOKEN_USER_KEY);
  }

  function setActiveSession(userId, token) {
    setToken(token);
    if (token && userId) {
      setTokenForUser(userId, token);
      localStorage.setItem(ACTIVE_TOKEN_USER_KEY, userId);
      return;
    }
    localStorage.removeItem(ACTIVE_TOKEN_USER_KEY);
  }

  // ─── DEVICE FINGERPRINT ───────────────────────────────────────────
  async function getDeviceFingerprint() {
    const raw = [
      navigator.userAgent,
      `${screen.width}x${screen.height}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ].join('|');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ─── BASE HTTP HELPER ─────────────────────────────────────────────
  async function _call(path, { method = 'GET', body, useRegToken = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = useRegToken ? (getRegToken() || getToken()) : getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res, data;
    try {
      res = await fetch(`${FUNCTIONS_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      data = await res.json();
    } catch (e) {
      throw e;
    }
    return data;
  }

  // ─── SHA-256 (local-only mode password hashing) ───────────────────
  async function _sha256(password) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function _emitSync(detail) {
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail }));
  }

  function _writeJSONIfChanged(key, value) {
    const next = JSON.stringify(value);
    const prev = localStorage.getItem(key);
    if (prev === next) return false;
    localStorage.setItem(key, next);
    return true;
  }

  function _mergeCurrentUser(user, extra = {}) {
    if (!user?.id) return null;

    const users = Credo.getUsers();
    const index = users.findIndex((item) => item.id === user.id);
    const existing = index >= 0 ? users[index] : {};
    const merged = {
      ratings: Array.isArray(existing.ratings) ? existing.ratings : [],
      chats: Array.isArray(existing.chats) ? existing.chats : [],
      ...(existing.passwordHash ? { passwordHash: existing.passwordHash } : {}),
      ...existing,
      ...user,
      ...extra,
    };

    if (index >= 0) users[index] = merged;
    else users.push(merged);

    localStorage.setItem('credo_users', JSON.stringify(users));
    return merged;
  }

  async function _syncCurrentUser() {
    const meRes = await _call('/me', { useRegToken: true });
    if (!meRes.ok || !meRes.user) {
      return { ok: false, changed: false, error: meRes.error || 'sync_failed' };
    }

    let currentId = Credo.getCurrentUserId();
    const previous = currentId ? Credo.getUserById(currentId) : null;
    const merged = _mergeCurrentUser(meRes.user);
    const changed = JSON.stringify(previous) !== JSON.stringify(merged);

    if (merged?.id) {
      const activeToken = getToken();
      if (activeToken) {
        setActiveSession(merged.id, activeToken);
      }
      Credo.setCurrentUserId(merged.id);
      Credo.markDeviceAccount(merged.id);
    }

    return {
      ok: true,
      changed,
      user: merged,
      canApprove: Boolean(meRes.canApprove),
    };
  }

  async function _syncGroupsFromServer() {
    const groupsRes = await _call('/groups');
    if (!groupsRes.ok) {
      return { ok: false, changed: false, error: groupsRes.error || 'groups_sync_failed' };
    }

    const groupsChanged = _writeJSONIfChanged('credo_groups', groupsRes.groups || []);
    const invitesChanged = _writeJSONIfChanged('credo_group_invites', groupsRes.invites || []);

    const groups = Array.isArray(groupsRes.groups) ? groupsRes.groups : [];
    const existingGroupChats = JSON.parse(localStorage.getItem('credo_group_chats') || '{}');
    let groupChatsChanged = false;

    await Promise.allSettled(groups.map(async (group) => {
      try {
        const msgRes = await _call(`/messages?groupId=${encodeURIComponent(group.id)}`);
        const nextMessages = (msgRes.ok && Array.isArray(msgRes.messages))
          ? msgRes.messages.map((m) => ({
              id: m.id,
              from: m.fromId,
              to: m.toId ?? null,
              groupId: m.groupId ?? group.id,
              text: m.text || '',
              type: m.type || 'text',
              attachmentPath: m.attachmentPath ?? null,
              attachmentUrl: m.attachmentUrl ?? null,
              attachmentMime: m.attachmentMime ?? null,
              attachmentBytes: m.attachmentBytes ?? null,
              attachmentWidth: m.attachmentWidth ?? null,
              attachmentHeight: m.attachmentHeight ?? null,
              time: m.time,
              readAt: m.readAt ?? null,
            }))
          : [];

        if (JSON.stringify(existingGroupChats[group.id] || []) !== JSON.stringify(nextMessages)) {
          existingGroupChats[group.id] = nextMessages;
          groupChatsChanged = true;
        }
      } catch { /* ignore individual group fetch failure */ }
    }));

    if (groupChatsChanged) {
      localStorage.setItem('credo_group_chats', JSON.stringify(existingGroupChats));
    }

    return {
      ok: true,
      changed: groupsChanged || invitesChanged || groupChatsChanged,
      groupsChanged,
      invitesChanged,
      groupChatsChanged,
    };
  }

  async function _syncBlocksFromServer() {
    const blocksRes = await _call('/block-user');
    if (!blocksRes.ok) {
      return { ok: false, changed: false, error: blocksRes.error || 'blocks_sync_failed' };
    }

    const changed = _writeJSONIfChanged('credo_user_blocks', blocksRes.blocks || []);
    return { ok: true, changed, blocksChanged: changed };
  }

  // ─── SYNC: populate localStorage from server ──────────────────────
  // Called after login and on each page load when a token exists.
  // Writes into the same localStorage keys that credo.js reads, so all
  // Credo.* read methods (getUsers, getChatMessages, etc.) work unchanged.
  async function _syncFromServer(currentUser) {
    try {
      const usersRes = await _call('/users');
      if (!usersRes.ok) {
        return { ok: false, changed: false, error: usersRes.error || 'sync_failed' };
      }

      // Build deduplicated user map; preserve local arrays (ratings, chats)
      const existingUsers = Credo.getUsers();
      const existingMap = {};
      existingUsers.forEach(u => { existingMap[u.id] = u; });

      const userMap = {};
      Credo.getDeviceAccounts().forEach(u => {
        if (!u?.id) return;
        userMap[u.id] = {
          ratings: u.ratings || [],
          chats:   u.chats   || [],
          ...u,
        };
      });

      [currentUser, ...usersRes.users, ...usersRes.pending].forEach(u => {
        if (!u?.id) return;
        const existing = existingMap[u.id] || {};
        const preservedPasswordHash = existing.passwordHash || userMap[u.id]?.passwordHash;
        userMap[u.id] = {
          ratings: existing.ratings || [],
          chats:   existing.chats   || [],
          ...(preservedPasswordHash ? { passwordHash: preservedPasswordHash } : {}),
          ...u,
        };
      });

      const allUsers = Object.values(userMap);
      let usersChanged = _writeJSONIfChanged('credo_users', allUsers);

      // Sync chat messages from each approved partner
      const partners = (usersRes.users || []).filter(u => u.id !== currentUser.id);
      const existingChats = JSON.parse(localStorage.getItem('credo_chats') || '{}');
      let chatsChanged = false;

      await Promise.allSettled(partners.map(async (partner) => {
        try {
          const msgRes = await _call(`/messages?partnerId=${partner.id}`);
          const chatKey = [currentUser.id, partner.id].sort().join('::');
          const nextMessages = (msgRes.ok && Array.isArray(msgRes.messages))
            ? msgRes.messages.map(m => ({
              id: m.id,
              from: m.fromId,
              to: m.toId,
              groupId: m.groupId ?? null,
              text: m.text,
              type: m.type || 'text',
              attachmentPath: m.attachmentPath ?? null,
              attachmentUrl: m.attachmentUrl ?? null,
              attachmentMime: m.attachmentMime ?? null,
              attachmentBytes: m.attachmentBytes ?? null,
              attachmentWidth: m.attachmentWidth ?? null,
              attachmentHeight: m.attachmentHeight ?? null,
              time: m.time,
              readAt: m.readAt ?? null,
            }))
            : [];

          if (JSON.stringify(existingChats[chatKey] || []) !== JSON.stringify(nextMessages)) {
            existingChats[chatKey] = nextMessages;
            chatsChanged = true;
          }

          if (!nextMessages.length) return;

          // Keep chats[] arrays on user objects in sync
          const cu = userMap[currentUser.id];
          const pu = userMap[partner.id];
          if (cu && !cu.chats.includes(partner.id)) cu.chats.push(partner.id);
          if (pu && !pu.chats.includes(currentUser.id)) pu.chats.push(currentUser.id);
        } catch { /* skip individual chat failure */ }
      }));

      if (chatsChanged) {
        localStorage.setItem('credo_chats', JSON.stringify(existingChats));
      }

      const finalUsers = Object.values(userMap);
      usersChanged = _writeJSONIfChanged('credo_users', finalUsers) || usersChanged;
      Credo.setCurrentUserId(currentUser.id);
      return {
        ok: true,
        changed: usersChanged || chatsChanged,
        usersChanged,
        chatsChanged,
      };

    } catch (e) {
      console.warn('[API] Sync from server failed:', e);
      return { ok: false, changed: false, error: 'network_error' };
    }
  }

  // ─── MONKEY-PATCH CREDO WRITE METHODS ────────────────────────────
  // Each patched method:
  //   1. Calls the original Credo method — updates localStorage immediately
  //      (synchronous, so app.js view rendering works unchanged)
  //   2. Fires the backend call as a background side-effect (fire-and-forget)
  async function syncNow() {
    if (!FUNCTIONS_BASE || !hasSessionToken()) {
      return { ok: false, changed: false, error: 'not_authenticated' };
    }

    if (_syncInFlight) return _syncInFlight;

    let currentId = Credo.getCurrentUserId();
    const currentUser = currentId ? Credo.getUserById(currentId) : null;
    if (!currentUser) {
      return { ok: false, changed: false, error: 'missing_current_user' };
    }

    _syncInFlight = (async () => {
      const meResult = await _syncCurrentUser();
      if (!meResult.ok || !meResult.user) return meResult;

      const hasLoginToken = Boolean(getToken());
      if (!hasLoginToken || meResult.user.status !== 'approved') {
        return meResult;
      }

      const [serverResult, groupsResult, blocksResult] = await Promise.all([
        _syncFromServer(meResult.user),
        _syncGroupsFromServer(),
        _syncBlocksFromServer(),
      ]);
      return {
        ok: serverResult.ok && groupsResult.ok,
        error: serverResult.error || groupsResult.error,
        changed: Boolean(meResult.changed || serverResult.changed || groupsResult.changed || blocksResult.changed),
      };
    })()
      .then((result) => {
        if (result?.ok && result.changed) _emitSync(result);
        return result;
      })
      .finally(() => {
        _syncInFlight = null;
      });

    return _syncInFlight;
  }

  function startLiveSync() {
    if (!FUNCTIONS_BASE || !hasSessionToken()) return;
    stopLiveSync();
    _syncTimer = setInterval(() => {
      syncNow().catch(() => {});
    }, SYNC_INTERVAL);
  }

  function stopLiveSync() {
    clearInterval(_syncTimer);
    _syncTimer = null;
  }

  function _patchCredo() {
    if (!FUNCTIONS_BASE) return; // local-only mode: no patching needed

    // approveUser
    const _origApprove = Credo.approveUser.bind(Credo);
    Credo.approveUser = function(userId) {
      const before = Credo.getUserById(userId);
      const result = _origApprove(userId);
      _call('/approve', { method: 'POST', body: { userId } })
        .then((res) => {
          if (!res?.ok && before) {
            Credo.updateUser(userId, {
              status: before.status,
              cred: before.cred,
            });
            _emitSync({ ok: false, changed: true, error: res.error || 'approve_failed' });
          }
        })
        .catch(e => console.warn('[API] approve backend error:', e));
      return result;
    };

    // rejectUser — also sends device fingerprint for device blocking
    const _origReject = Credo.rejectUser.bind(Credo);
    Credo.rejectUser = function(userId) {
      const before = Credo.getUserById(userId);
      const result = _origReject(userId);
      getDeviceFingerprint()
        .then(fp => _call('/reject', { method: 'POST', body: { userId, deviceFingerprint: fp } }))
        .then((res) => {
          if (!res?.ok && before) {
            Credo.updateUser(userId, { status: before.status });
            _emitSync({ ok: false, changed: true, error: res.error || 'reject_failed' });
          }
        })
        .catch(e => console.warn('[API] reject backend error:', e));
      return result;
    };

    // rateUser — only fires backend call if local validation passed
    const _origRate = Credo.rateUser.bind(Credo);
    Credo.rateUser = function(fromId, toId, score) {
      const result = _origRate(fromId, toId, score);
      if (result.ok) {
        _call('/rate', { method: 'POST', body: { toId, score } })
          .catch(e => console.warn('[API] rate backend error:', e));
      }
      return result;
    };

    // sendMessage
    const _origSend = Credo.sendMessage.bind(Credo);
    _origSendMessage = _origSend;
    Credo.sendMessage = function(fromId, toId, text) {
      const localResult = _origSend(fromId, toId, text);
      if (localResult?.ok === false) return localResult;
      _call('/messages', { method: 'POST', body: { toId, text } })
        .catch(e => console.warn('[API] sendMessage backend error:', e));
      return localResult;
    };
  }

  // ─── API.register ─────────────────────────────────────────────────
  async function register({ fullName, school, grade, nickname, phone = '' }) {
    // LOCAL MODE
    if (!FUNCTIONS_BASE) {
      return Credo.registerUser(fullName, school, grade, nickname);
    }

    // BACKEND MODE
    let deviceFingerprint;
    try {
      deviceFingerprint = await getDeviceFingerprint();
    } catch {
      deviceFingerprint = '';
    }

    let result;
    try {
      result = await _call('/register', {
        method: 'POST',
        body: { fullName, school, grade, nickname, phone, deviceFingerprint },
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }

    if (!result.ok) return result;

    const user = result.user;

    // Store the registration JWT so /set-password can be called immediately
    if (result.token) setRegToken(result.token);
    _mergeCurrentUser(user);

    Credo.setCurrentUserId(user.id);
    Credo.markDeviceAccount(user.id);
    startLiveSync();
    return result;
  }

  // ─── API.setPassword ──────────────────────────────────────────────
  async function setPassword(userId, password) {
    // LOCAL MODE
    if (!FUNCTIONS_BASE) {
      const hash = await _sha256(password);
      return Credo.updateUser(userId, { passwordHash: hash });
    }

    // BACKEND MODE — uses the registration token (or session token if re-setting)
    let result;
    try {
      result = await _call('/set-password', {
        method: 'POST',
        body: { password },
        useRegToken: true,
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }

    if (!result.ok) return result;

    // Mark password as set locally (sentinel avoids storing hash client-side)
    Credo.updateUser(userId, { passwordHash: '__set__' });

    const currentUser = Credo.getUserById(userId);
    if (!currentUser?.nickname) return result;

    const loginResult = await login(currentUser.nickname, password);
    if (!loginResult.ok) {
      return { ok: false, error: loginResult.error || 'login_after_set_password_failed' };
    }

    setRegToken(null);
    return { ...result, token: loginResult.token, user: loginResult.user };
  }

  // ─── API.login ────────────────────────────────────────────────────
  async function login(nickname, password) {
    // LOCAL MODE
    if (!FUNCTIONS_BASE) {
      const users = Credo.getUsers();
      const user = users.find(u => u.nickname === nickname);
      if (!user || !user.passwordHash) return { ok: false };
      const hash = await _sha256(password);
      // Accept both SHA-256 hash and '__set__' sentinel (backend-set password)
      if (user.passwordHash === hash || user.passwordHash === '__set__') {
        Credo.setCurrentUserId(user.id);
        Credo.markDeviceAccount(user.id);
        return { ok: true, user };
      }
      return { ok: false };
    }

    // BACKEND MODE
    let result;
    try {
      result = await _call('/login', { method: 'POST', body: { nickname, password } });
    } catch {
      return { ok: false, error: 'network_error' };
    }

    if (!result.ok) return result;

    // Store session token and sync all data into localStorage
    setActiveSession(result.user.id, result.token);
    Credo.setCurrentUserId(result.user.id);
    Credo.markDeviceAccount(result.user.id);
    const seededUser = _mergeCurrentUser(result.user, { passwordHash: '__set__' });

    await _syncFromServer(seededUser);
    await Promise.allSettled([
      _syncGroupsFromServer(),
      _syncBlocksFromServer(),
    ]);
    Credo.updateUser(result.user.id, { passwordHash: '__set__' });
    startLiveSync();

    return result;
  }

  // ─── API.verifyPhone ──────────────────────────────────────────────
  // Submits an OTP code received via SMS.
  // Backend mode: POST /verify-phone { phone, code }
  // Local mode:   treated as always-success (no SMS in local demo)
  async function verifyPhone(phone, code) {
    if (!FUNCTIONS_BASE) return { ok: true };

    let result;
    try {
      result = await _call('/verify-phone', {
        method: 'POST',
        body: { phone, code },
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }
    return result;
  }

  // ─── API.resendOtp ────────────────────────────────────────────────
  // Invalidates existing OTPs and sends a fresh code to the phone.
  // Local mode: no-op (returns success immediately).
  async function resendOtp(phone) {
    if (!FUNCTIONS_BASE) return { ok: true };

    let result;
    try {
      result = await _call('/resend-otp', {
        method: 'POST',
        body: { phone },
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }
    return result;
  }

  // ─── API.logout ───────────────────────────────────────────────────
  // Revokes the server-side session (deletes the sessions row for this jti)
  // and clears all local JWT state.
  // Safe to call even if the token is already expired or missing.
  async function logout() {
    if (FUNCTIONS_BASE && getToken()) {
      try {
        await _call('/logout', { method: 'POST' });
      } catch {
        // Non-fatal — clear local state regardless of network outcome.
      }
    }
    const activeTokenUserId = getActiveTokenUserId();
    if (activeTokenUserId) {
      removeTokenForUser(activeTokenUserId);
    }
    setActiveSession(null, null);
    setRegToken(null);
    stopLiveSync();
    Credo.setCurrentUserId(null);
    return { ok: true };
  }

  // ─── API.approve / reject ─────────────────────────────────────────
  // These delegate to the (already monkey-patched) Credo methods,
  // preserving the original call sites in app.js that use Credo directly.
  async function switchAccount(userId) {
    if (!FUNCTIONS_BASE) {
      Credo.setCurrentUserId(userId || null);
      if (userId) Credo.markDeviceAccount(userId);
      return { ok: true, user: userId ? Credo.getUserById(userId) : null };
    }

    if (!userId) {
      await logout();
      return { ok: true, user: null };
    }

    const nextUser = Credo.getUserById(userId);
    if (!nextUser) return { ok: false, error: 'user_not_found' };

    const nextToken = getTokenForUser(userId);
    if (!nextToken) return { ok: false, error: 'login_required' };

    const previousCurrentUserId = Credo.getCurrentUserId();
    const previousTokenUserId = getActiveTokenUserId();
    const previousToken = getToken();

    setActiveSession(userId, nextToken);
    Credo.setCurrentUserId(userId);
    Credo.markDeviceAccount(userId);

    const syncResult = await syncNow();
    if (syncResult?.ok) {
      startLiveSync();
      return {
        ok: true,
        user: Credo.getUserById(Credo.getCurrentUserId()) || nextUser,
      };
    }

    if (['invalid_token', 'missing_token', 'session_revoked', 'token_expired', 'user_not_found'].includes(syncResult?.error)) {
      removeTokenForUser(userId);
    }

    if (previousToken) {
      const restoreUserId = previousTokenUserId || previousCurrentUserId;
      if (restoreUserId) {
        setActiveSession(restoreUserId, previousToken);
      } else {
        localStorage.removeItem(ACTIVE_TOKEN_USER_KEY);
        setToken(previousToken);
      }
    } else {
      setActiveSession(null, null);
    }

    Credo.setCurrentUserId(previousCurrentUserId || null);
    if (previousToken) startLiveSync();
    else stopLiveSync();

    return { ok: false, error: syncResult?.error || 'switch_failed' };
  }

  function approve(userId) {
    return Credo.approveUser(userId);
  }

  function reject(userId) {
    return Credo.rejectUser(userId);
  }

  async function createGroup(name, memberIds) {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (!FUNCTIONS_BASE) {
      return Credo.createGroup(name, currentUser?.school || '', currentUser?.id, memberIds);
    }

    const result = await _call('/groups', {
      method: 'POST',
      body: {
        action: 'create',
        name,
        memberIds,
      },
    });

    if (result.ok) {
      await syncNow().catch(() => {});
    }

    return result;
  }

  async function respondGroupInvite(inviteId, decision) {
    if (!FUNCTIONS_BASE) {
      return Credo.respondGroupInvite(inviteId, Credo.getCurrentUserId(), decision);
    }

    const result = await _call('/groups', {
      method: 'POST',
      body: {
        action: 'respond_invite',
        inviteId,
        decision,
      },
    });

    if (result.ok) {
      await syncNow().catch(() => {});
    }

    return result;
  }

  async function leaveGroup(groupId) {
    if (!FUNCTIONS_BASE) return { ok: false, error: 'not_supported_local' };

    const result = await _call('/groups', {
      method: 'POST',
      body: {
        action: 'leave',
        groupId,
      },
    });

    if (result.ok) {
      await syncNow().catch(() => {});
    }

    return result;
  }

  async function syncBlocks() {
    if (!FUNCTIONS_BASE) {
      return { ok: true, changed: false, blocks: Credo.getUserBlocks ? Credo.getUserBlocks() : [] };
    }

    try {
      const result = await _call('/block-user');
      if (result.ok && typeof Credo.saveUserBlocks === 'function') {
        Credo.saveUserBlocks(result.blocks || []);
      }
      return result;
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  async function blockUser(targetId) {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (!currentUser) return { ok: false, error: 'not_authenticated' };

    if (!FUNCTIONS_BASE) {
      return Credo.blockUserLocal(currentUser.id, targetId);
    }

    let result;
    try {
      result = await _call('/block-user', {
        method: 'POST',
        body: { targetId, action: 'block' },
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }

    if (result.ok && typeof Credo.saveUserBlocks === 'function') {
      Credo.saveUserBlocks(result.blocks || []);
      _emitSync({ ok: true, changed: true, blocksChanged: true });
    }
    return result;
  }

  async function unblockUser(targetId) {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (!currentUser) return { ok: false, error: 'not_authenticated' };

    if (!FUNCTIONS_BASE) {
      return Credo.unblockUserLocal(currentUser.id, targetId);
    }

    let result;
    try {
      result = await _call('/block-user', {
        method: 'POST',
        body: { targetId, action: 'unblock' },
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }

    if (result.ok && typeof Credo.saveUserBlocks === 'function') {
      Credo.saveUserBlocks(result.blocks || []);
      _emitSync({ ok: true, changed: true, blocksChanged: true });
    }
    return result;
  }

  async function reportUser(targetId, reason, details = '') {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (!currentUser) return { ok: false, error: 'not_authenticated' };

    if (!FUNCTIONS_BASE) {
      const reports = _loadLocalReports();
      const report = {
        id: Credo.generateId(),
        reporterId: currentUser.id,
        targetId,
        reason,
        details: String(details || '').trim(),
        status: 'open',
        createdAt: new Date().toISOString(),
        reporter: currentUser,
        target: Credo.getUserById(targetId),
      };
      reports.unshift(report);
      localStorage.setItem('credo_user_reports', JSON.stringify(reports));
      return { ok: true, report };
    }

    try {
      return await _call('/report-user', {
        method: 'POST',
        body: { targetId, reason, details },
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  async function listReports(status = 'open') {
    if (!FUNCTIONS_BASE) {
      const reports = _serializeLocalReports(_loadLocalReports());
      const filtered = status === 'all'
        ? reports
        : reports.filter((report) => report.status === status);
      return { ok: true, reports: filtered, summary: _summarizeReports(filtered) };
    }

    try {
      return await _call(`/reports-admin?status=${encodeURIComponent(status)}`);
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  async function reviewReport(reportId, action) {
    if (!FUNCTIONS_BASE) {
      const nextStatus = { review: 'reviewed', reviewed: 'reviewed', dismiss: 'dismissed', dismissed: 'dismissed', action: 'actioned', actioned: 'actioned' }[action];
      if (!nextStatus) return { ok: false, error: 'invalid_action' };

      const reports = _loadLocalReports();
      const index = reports.findIndex((report) => report.id === reportId);
      if (index === -1) return { ok: false, error: 'report_not_found' };
      reports[index] = {
        ...reports[index],
        status: nextStatus,
        reviewedBy: Credo.getCurrentUserId(),
        reviewedAt: new Date().toISOString(),
      };
      localStorage.setItem('credo_user_reports', JSON.stringify(reports));
      return { ok: true, report: _serializeLocalReports([reports[index]])[0] };
    }

    try {
      return await _call('/reports-admin', {
        method: 'POST',
        body: { reportId, action },
      });
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  function _loadLocalReports() {
    try {
      const parsed = JSON.parse(localStorage.getItem('credo_user_reports') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function _serializeLocalReports(reports) {
    return reports.map((report) => ({
      ...report,
      reporter: report.reporter || Credo.getUserById(report.reporterId),
      target: report.target || Credo.getUserById(report.targetId),
      reviewer: report.reviewedBy ? Credo.getUserById(report.reviewedBy) : null,
    }));
  }

  function _summarizeReports(reports) {
    return {
      total: reports.length,
      open: reports.filter((report) => report.status === 'open').length,
      reviewed: reports.filter((report) => report.status === 'reviewed').length,
      dismissed: reports.filter((report) => report.status === 'dismissed').length,
      actioned: reports.filter((report) => report.status === 'actioned').length,
    };
  }

  async function adminStats() {
    if (!FUNCTIONS_BASE) {
      const users = Credo.getUsers();
      const groups = Credo.getGroups();
      const directChats = JSON.parse(localStorage.getItem('credo_chats') || '{}');
      const groupChats = JSON.parse(localStorage.getItem('credo_group_chats') || '{}');
      const allMessages = [
        ...Object.values(directChats).flat(),
        ...Object.values(groupChats).flat(),
      ];
      const reports = _loadLocalReports();
      const blocks = typeof Credo.getUserBlocks === 'function' ? Credo.getUserBlocks() : [];
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const since24h = now - dayMs;
      const since7d = now - dayMs * 7;
      const makeDailyBuckets = (days) => {
        const buckets = [];
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - (days - 1));
        for (let index = 0; index < days; index += 1) {
          const day = new Date(start);
          day.setDate(start.getDate() + index);
          const key = day.toISOString().slice(0, 10);
          buckets.push({
            key,
            label: `${String(day.getDate()).padStart(2, '0')}.${String(day.getMonth() + 1).padStart(2, '0')}`,
            count: 0,
          });
        }
        return buckets;
      };
      const registrationsByDay = makeDailyBuckets(7);
      const messagesByDay = makeDailyBuckets(7);
      const bucketRegistration = (value, buckets) => {
        if (!value) return;
        const key = new Date(value).toISOString().slice(0, 10);
        const bucket = buckets.find((item) => item.key === key);
        if (bucket) bucket.count += 1;
      };
      const schoolMap = new Map();

      users.forEach((user) => {
        bucketRegistration(user.createdAt, registrationsByDay);
        const school = String(user.school || '').trim();
        if (!school) return;
        const current = schoolMap.get(school) || {
          school,
          totalUsers: 0,
          approvedUsers: 0,
          pendingUsers: 0,
        };
        current.totalUsers += 1;
        if (user.status === 'approved') current.approvedUsers += 1;
        if (user.status === 'pending') current.pendingUsers += 1;
        schoolMap.set(school, current);
      });

      allMessages.forEach((message) => {
        bucketRegistration(message.time, messagesByDay);
      });

      const schools = [...schoolMap.values()]
        .sort((a, b) => b.totalUsers - a.totalUsers || a.school.localeCompare(b.school, 'ru'));

      return {
        ok: true,
        summary: {
          totalUsers: users.length,
          approvedUsers: users.filter((user) => user.status === 'approved').length,
          pendingUsers: users.filter((user) => user.status === 'pending').length,
          rejectedUsers: users.filter((user) => user.status === 'rejected').length,
          adminUsers: users.filter((user) => user.role === 'admin').length,
          newUsers24h: users.filter((user) => new Date(user.createdAt || 0).getTime() >= since24h).length,
          newUsers7d: users.filter((user) => new Date(user.createdAt || 0).getTime() >= since7d).length,
          newApplications24h: users.filter((user) => user.status === 'pending' && new Date(user.createdAt || 0).getTime() >= since24h).length,
          totalMessages: allMessages.length,
          messages24h: allMessages.filter((message) => new Date(message.time || 0).getTime() >= since24h).length,
          images24h: allMessages.filter((message) => message.type === 'image' && new Date(message.time || 0).getTime() >= since24h).length,
          totalGroups: groups.length,
          publicGroups: groups.filter((group) => group.type === 'school_public').length,
          privateGroups: groups.filter((group) => group.type === 'private').length,
          pendingInvites: Credo.getGroupInvites().length,
          totalReports: reports.length,
          openReports: reports.filter((report) => report.status === 'open').length,
          reports24h: reports.filter((report) => new Date(report.createdAt || 0).getTime() >= since24h).length,
          totalBlocks: blocks.length,
        },
        charts: {
          registrationsByDay,
          messagesByDay,
          topSchoolsByUsers: schools.slice(0, 6).map((school) => ({
            label: school.school,
            value: school.totalUsers,
            pendingUsers: school.pendingUsers,
          })),
        },
        schools: schools.slice(0, 12),
        recentUsers: [...users].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0, 12),
        groups,
      };
    }

    try {
      return await _call('/admin-stats');
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  async function uploadMedia(file, width = null, height = null) {
    if (!FUNCTIONS_BASE) {
      return { ok: false, error: 'not_supported_local' };
    }

    const formData = new FormData();
    formData.append('file', file);
    if (width) formData.append('width', String(width));
    if (height) formData.append('height', String(height));

    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res, data;
    try {
      res = await fetch(`${FUNCTIONS_BASE}/upload-media`, {
        method: 'POST',
        headers,
        body: formData,
      });
      data = await res.json();
    } catch {
      return { ok: false, error: 'network_error' };
    }

    return data;
  }

  async function sendMessage(payloadOrFromId, maybeToId, maybeText) {
    const payload = typeof payloadOrFromId === 'object' && payloadOrFromId !== null
      ? payloadOrFromId
      : { fromId: payloadOrFromId, toId: maybeToId, text: maybeText };

    const {
      fromId,
      toId = null,
      groupId = null,
      text = '',
      file = null,
    } = payload;

    if (!FUNCTIONS_BASE) {
      if (groupId) {
        Credo.sendGroupMessage(groupId, fromId, text);
        const messages = Credo.getGroupMessages(groupId);
        return { ok: true, message: messages[messages.length - 1] || null };
      }
      if (typeof Credo.isUserBlockedFor === 'function' && Credo.isUserBlockedFor(fromId, toId)) {
        return { ok: false, error: 'user_blocked' };
      }
      const localResult = Credo.sendMessage(fromId, toId, text);
      if (localResult?.ok === false) return localResult;
      const messages = Credo.getChatMessages(fromId, toId);
      return { ok: true, message: messages[messages.length - 1] || null };
    }

    if (groupId || file) {
      let media = null;
      if (file) {
        const uploadResult = await uploadMedia(file, payload.imageWidth, payload.imageHeight);
        if (!uploadResult.ok) return uploadResult;
        media = uploadResult.media;
      }

      const body = {
        toId,
        groupId,
        text,
        attachmentPath: media?.path || null,
        attachmentMime: media?.mime || null,
        attachmentBytes: media?.bytes || null,
        attachmentWidth: media?.width || null,
        attachmentHeight: media?.height || null,
      };

      const sendGroupPayload = async () => {
        try {
          return await _call('/messages', {
          method: 'POST',
          body,
        });
        } catch {
          return { ok: false, error: 'network_error' };
        }
      };

      let result = await sendGroupPayload();
      if (!result?.ok && result?.error === 'group_not_found') {
        await syncNow().catch(() => {});
        result = await sendGroupPayload();
      }

      if (result?.ok) {
        await syncNow().catch(() => {});
      }
      return result;
    }

    const originalSend = _origSendMessage || Credo.sendMessage.bind(Credo);
    if (typeof Credo.isUserBlockedFor === 'function' && Credo.isUserBlockedFor(fromId, toId)) {
      return { ok: false, error: 'user_blocked' };
    }
    const chatKey = Credo.chatKey(fromId, toId);
    const previousMessages = Credo.getChatMessages(fromId, toId).slice();
    const usersSnapshot = Credo.getUsers().map((user) => ({
      ...user,
      ratings: Array.isArray(user.ratings) ? [...user.ratings] : [],
      chats: Array.isArray(user.chats) ? [...user.chats] : [],
    }));

    originalSend(fromId, toId, text);

    let result;
    try {
      result = await _call('/messages', { method: 'POST', body: { toId, text } });
    } catch {
      result = { ok: false, error: 'network_error' };
    }

    if (!result?.ok) {
      const chats = JSON.parse(localStorage.getItem('credo_chats') || '{}');
      if (previousMessages.length > 0) chats[chatKey] = previousMessages;
      else delete chats[chatKey];
      localStorage.setItem('credo_chats', JSON.stringify(chats));
      localStorage.setItem('credo_users', JSON.stringify(usersSnapshot));
      return result;
    }

    await syncNow().catch(() => {});
    return result;
  }

  // ─── INIT ─────────────────────────────────────────────────────────
  function _init() {
    _patchCredo();

    if (!FUNCTIONS_BASE) return;

    // On page load with an existing session: re-sync data from server.
    // This runs in the background — app.js will use the cached localStorage
    // data immediately; the UI will reflect server data on next route() call.
    if (!hasSessionToken()) return;

    const currentId = Credo.getCurrentUserId();
    if (!currentId) return;

    const storedToken = getTokenForUser(currentId);
    const activeTokenUserId = getActiveTokenUserId();
    if (storedToken) {
      if (getToken() !== storedToken || activeTokenUserId !== currentId) {
        setActiveSession(currentId, storedToken);
      }
    } else if (activeTokenUserId && activeTokenUserId !== currentId) {
      Credo.setCurrentUserId(activeTokenUserId);
      currentId = activeTokenUserId;
    }

    Credo.markDeviceAccount(currentId);

    let currentUser = Credo.getUserById(currentId);
    if (currentUser && !currentUser.passwordHash) {
      currentUser = Credo.updateUser(currentId, { passwordHash: '__set__' }) || currentUser;
    }
    if (currentUser) {
      syncNow().catch(() => {});
      startLiveSync();
    }
  }

  // Patch before app.js DOMContentLoaded handler fires
  document.addEventListener('DOMContentLoaded', _init, { once: true });

  return {
    register,
    login,
    logout,
    setPassword,
    verifyPhone,
    resendOtp,
    sendMessage,
    createGroup,
    respondGroupInvite,
    leaveGroup,
    syncBlocks,
    blockUser,
    unblockUser,
    reportUser,
    listReports,
    reviewReport,
    uploadMedia,
    adminStats,
    switchAccount,
    syncNow,
    startLiveSync,
    stopLiveSync,
    isBackendEnabled: () => Boolean(FUNCTIONS_BASE),
    SYNC_EVENT,
    approve,
    reject,
  };

})();
