'use strict';

/**
 * presence.js — «Живые» статусы пользователей.
 *
 * Механизм: localStorage как общая шина между вкладками.
 *   - Один таб записывает своё состояние → другие табы читают через
 *     событие `storage` (мгновенно) или через setInterval (fallback).
 *   - В demo-режиме (переключение пользователей в одном браузере) это
 *     работает идеально: каждый «пользователь» пишет в свой ключ.
 *
 * Ключи localStorage:
 *   fcom_presence_<userId>  →  {
 *     lastActive : number,           // Date.now() последней активности
 *     typing     : { [partnerId]: number | null }  // метка начала набора
 *   }
 */
const Presence = (() => {

  const PREFIX           = 'fcom_presence_';
  const ONLINE_THRESHOLD = 5 * 60 * 1000;   // ≤5 мин → «онлайн»
  const TYPING_TIMEOUT   = 3 * 1000;         // >3 сек без события → «не печатает»
  const ACTIVITY_TICK    = 60 * 1000;        // интервал heartbeat моей активности

  // ─── Низкоуровневый I/O ─────────────────────────────────────────

  function _read(userId) {
    try { return JSON.parse(localStorage.getItem(PREFIX + userId) || 'null'); }
    catch { return null; }
  }

  function _write(userId, patch) {
    const current = _read(userId) || {};
    localStorage.setItem(PREFIX + userId, JSON.stringify({ ...current, ...patch }));
  }

  // ─── Публичный API: писать своё состояние ───────────────────────

  /** Обновить метку последней активности (вызывается по событиям ввода/клика). */
  function touchActive(userId) {
    if (!userId) return;
    _write(userId, { lastActive: Date.now() });
  }

  /**
   * Выставить/снять флаг «печатает» в чате с partnerId.
   * @param {string}  userId
   * @param {string}  partnerId
   * @param {boolean} isTyping
   */
  function setTyping(userId, partnerId, isTyping) {
    if (!userId || !partnerId) return;
    const current = _read(userId) || {};
    const typing  = { ...(current.typing || {}) };
    typing[partnerId] = isTyping ? Date.now() : null;
    _write(userId, { typing });
  }

  // ─── Публичный API: читать чужое состояние ──────────────────────

  /** true, если пользователь был активен в последние ONLINE_THRESHOLD мс. */
  function isOnline(userId) {
    const p = _read(userId);
    if (!p || !p.lastActive) return false;
    return (Date.now() - p.lastActive) < ONLINE_THRESHOLD;
  }

  /** Время последней активности (Date) или null. */
  function getLastSeen(userId) {
    const p = _read(userId);
    if (!p || !p.lastActive) return null;
    return new Date(p.lastActive);
  }

  /** true, если userId сейчас печатает сообщение для myId. */
  function isTypingTo(userId, myId) {
    const p = _read(userId);
    if (!p || !p.typing) return false;
    const ts = p.typing[myId];
    if (!ts) return false;
    return (Date.now() - ts) < TYPING_TIMEOUT;
  }

  // ─── Форматирование «был(а) X назад» ────────────────────────────

  function formatLastSeen(date) {
    if (!date) return '';
    const diff = Date.now() - date.getTime();
    if (diff < 60_000)      return 'был(а) только что';
    if (diff < 3_600_000) {
      const min = Math.floor(diff / 60_000);
      return `был(а) ${min} мин. назад`;
    }
    if (diff < 86_400_000) {
      return `был(а) в ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    }
    return `был(а) ${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
  }

  // ─── Автоотслеживание активности текущего пользователя ──────────

  let _myUserId     = null;
  let _activityTimer = null;

  /**
   * Запустить heartbeat: периодически обновлять lastActive для userId
   * и подписаться на события страницы.
   */
  function startActivityTracking(userId) {
    if (_myUserId === userId) return; // уже запущено для этого пользователя
    stopActivityTracking();
    _myUserId = userId;
    touchActive(userId);

    clearInterval(_activityTimer);
    _activityTimer = setInterval(() => {
      if (_myUserId) touchActive(_myUserId);
    }, ACTIVITY_TICK);

    // При возврате на вкладку — мгновенный bump
    document.addEventListener('visibilitychange', _onVisibilityChange);
  }

  function _onVisibilityChange() {
    if (!document.hidden && _myUserId) touchActive(_myUserId);
  }

  function stopActivityTracking() {
    clearInterval(_activityTimer);
    _activityTimer = null;
    _myUserId = null;
    document.removeEventListener('visibilitychange', _onVisibilityChange);
  }

  // ─── Наблюдение за конкретным партнёром (для экрана чата) ───────

  let _watchTimer    = null;
  let _watchCallback = null;
  let _watchPartner  = null;
  let _watchMyId     = null;

  /**
   * Подписаться на изменения присутствия partnerId.
   * callback вызывается с { online, typing, lastSeen }.
   */
  function watchPartner(partnerId, myId, callback) {
    stopWatching();
    _watchPartner  = partnerId;
    _watchMyId     = myId;
    _watchCallback = callback;

    _fireWatch(); // немедленный вызов

    // Polling: ловит изменения с других устройств и после TYPING_TIMEOUT
    _watchTimer = setInterval(_fireWatch, 1500);

    // storage event: мгновенная реакция на изменения в том же браузере
    window.addEventListener('storage', _onStorageChange);
  }

  function _onStorageChange(e) {
    if (e.key === PREFIX + _watchPartner) _fireWatch();
  }

  function _fireWatch() {
    if (!_watchCallback || !_watchPartner) return;
    _watchCallback({
      online:   isOnline(_watchPartner),
      typing:   isTypingTo(_watchPartner, _watchMyId),
      lastSeen: getLastSeen(_watchPartner),
    });
  }

  function stopWatching() {
    clearInterval(_watchTimer);
    _watchTimer = null;
    window.removeEventListener('storage', _onStorageChange);
    _watchPartner  = null;
    _watchMyId     = null;
    _watchCallback = null;
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    touchActive,
    setTyping,
    isOnline,
    getLastSeen,
    isTypingTo,
    formatLastSeen,
    startActivityTracking,
    stopActivityTracking,
    watchPartner,
    stopWatching,
  };

})();
