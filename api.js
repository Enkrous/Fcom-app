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
  const TOKEN_KEY     = 'fcom_token';      // long-lived session JWT (after login)
  const REG_TOKEN_KEY = 'fcom_reg_token';  // 1-hour JWT returned after /register

  let _syncTimer = null;
  let _syncInFlight = null;
  let _origSendMessage = null;

  function getToken()     { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t)    { t ? localStorage.setItem(TOKEN_KEY, t)     : localStorage.removeItem(TOKEN_KEY); }
  function getRegToken()  { return localStorage.getItem(REG_TOKEN_KEY); }
  function setRegToken(t) { t ? localStorage.setItem(REG_TOKEN_KEY, t) : localStorage.removeItem(REG_TOKEN_KEY); }
  function hasSessionToken() { return Boolean(getToken() || getRegToken()); }

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

    const currentId = Credo.getCurrentUserId();
    const previous = currentId ? Credo.getUserById(currentId) : null;
    const merged = _mergeCurrentUser(meRes.user);
    const changed = JSON.stringify(previous) !== JSON.stringify(merged);

    if (merged?.id) {
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
              text: m.text,
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

    const currentId = Credo.getCurrentUserId();
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

      const serverResult = await _syncFromServer(meResult.user);
      return {
        ...serverResult,
        changed: Boolean(meResult.changed || serverResult.changed),
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
      _origSend(fromId, toId, text);
      _call('/messages', { method: 'POST', body: { toId, text } })
        .catch(e => console.warn('[API] sendMessage backend error:', e));
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
    setToken(result.token);
    Credo.setCurrentUserId(result.user.id);
    Credo.markDeviceAccount(result.user.id);
    const seededUser = _mergeCurrentUser(result.user, { passwordHash: '__set__' });

    await _syncFromServer(seededUser);
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
    setToken(null);
    setRegToken(null);
    stopLiveSync();
    Credo.setCurrentUserId(null);
    return { ok: true };
  }

  // ─── API.approve / reject ─────────────────────────────────────────
  // These delegate to the (already monkey-patched) Credo methods,
  // preserving the original call sites in app.js that use Credo directly.
  function approve(userId) {
    return Credo.approveUser(userId);
  }

  function reject(userId) {
    return Credo.rejectUser(userId);
  }

  async function sendMessage(fromId, toId, text) {
    if (!FUNCTIONS_BASE) {
      Credo.sendMessage(fromId, toId, text);
      const messages = Credo.getChatMessages(fromId, toId);
      return { ok: true, message: messages[messages.length - 1] || null };
    }

    const originalSend = _origSendMessage || Credo.sendMessage.bind(Credo);
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
    syncNow,
    startLiveSync,
    stopLiveSync,
    isBackendEnabled: () => Boolean(FUNCTIONS_BASE),
    SYNC_EVENT,
    approve,
    reject,
  };

})();
