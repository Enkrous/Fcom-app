'use strict';

/**
 * notifications.js — Система уведомлений Fcom.
 *
 * Три типа:
 *   'message'  — новое сообщение  → nav-badge + счётчик на карточке чата
 *   'approval' → nav-badge + всплывающий toast при появлении новых заявок
 *   'rate'     → banner #rate-notification (управляется в app.js)
 *
 * Зависимости: Credo (должен быть загружен раньше).
 */
const Notif = (() => {

  // localStorage: fcom_chat_read_<userId> → { [partnerId]: number }
  const READ_KEY = 'fcom_chat_read_';

  // SVG-иконки для toast-типов (Lucide-style, 14×14)
  const ICONS = {
    message:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    approval: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    rate:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  };

  // ─── Read tracking (прочитанность сообщений) ────────────────────

  function _readStore(userId) {
    try { return JSON.parse(localStorage.getItem(READ_KEY + userId) || '{}'); }
    catch { return {}; }
  }

  /** Пометить чат как прочитанный (вызывать при открытии чата). */
  function markChatRead(userId, partnerId) {
    const msgs  = Credo.getChatMessages(userId, partnerId);
    const hasServerReadState = msgs.some((msg) => Object.prototype.hasOwnProperty.call(msg, 'readAt'));

    if (hasServerReadState) {
      const key = Credo.chatKey(userId, partnerId);
      const chats = JSON.parse(localStorage.getItem('credo_chats') || '{}');
      const readAt = new Date().toISOString();

      chats[key] = msgs.map((msg) => (
        msg.from === userId || msg.readAt
          ? msg
          : { ...msg, readAt }
      ));

      localStorage.setItem('credo_chats', JSON.stringify(chats));
    }

    const store = _readStore(userId);
    store[partnerId] = msgs.length;
    localStorage.setItem(READ_KEY + userId, JSON.stringify(store));
  }

  /**
   * Количество непрочитанных сообщений от partnerId.
   * Если последнее сообщение отправил я — считается прочитанным.
   */
  function getUnreadCount(userId, partnerId) {
    const msgs = Credo.getChatMessages(userId, partnerId);
    if (!msgs.length) return 0;

    const hasServerReadState = msgs.some((msg) => Object.prototype.hasOwnProperty.call(msg, 'readAt'));
    if (hasServerReadState) {
      return msgs.filter((msg) => msg.from !== userId && !msg.readAt).length;
    }

    if (msgs[msgs.length - 1].from === userId) return 0;
    const lastRead = _readStore(userId)[partnerId] || 0;
    return Math.max(0, msgs.length - lastRead);
  }

  /** Суммарный счётчик непрочитанных по всем чатам. */
  function getTotalUnread(userId) {
    return Credo.getApprovedUsers()
      .filter(u => u.id !== userId)
      .reduce((sum, u) => sum + getUnreadCount(userId, u.id), 0);
  }

  // ─── Toast engine ────────────────────────────────────────────────

  let _container = null;

  function _ensureContainer() {
    if (_container && _container.isConnected) return _container;
    _container = document.createElement('div');
    _container.className = 'toast-container';
    document.body.appendChild(_container);
    return _container;
  }

  function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Показать toast-уведомление.
   * @param {object}   opts
   * @param {'message'|'approval'|'rate'} opts.type
   * @param {string}   opts.text
   * @param {string}   [opts.actionLabel]
   * @param {Function} [opts.onAction]
   * @param {number}   [opts.duration=4500]
   */
  function showToast({ type = 'message', text, actionLabel, onAction, duration = 4500 }) {
    const c    = _ensureContainer();
    const icon = ICONS[type] || ICONS.message;
    const el   = document.createElement('div');
    el.className = `toast toast--${type}`;

    el.innerHTML =
      `<span class="toast-icon">${icon}</span>` +
      `<span class="toast-text">${_esc(text)}</span>` +
      (actionLabel ? `<button class="toast-btn">${_esc(actionLabel)}</button>` : '') +
      `<button class="toast-close" aria-label="Закрыть">&times;</button>`;

    function dismiss() {
      el.classList.add('toast--out');
      setTimeout(() => el.remove(), 280);
    }

    if (actionLabel && onAction) {
      el.querySelector('.toast-btn').addEventListener('click', () => { onAction(); dismiss(); });
    }
    el.querySelector('.toast-close').addEventListener('click', dismiss);

    c.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast--in'));
    setTimeout(dismiss, duration);

    return { dismiss };
  }

  // ─── Smart triggers (вызывать из app.js при каждом рендере) ─────

  let _lastPendingCount = -1; // -1 = ещё не инициализировано

  /**
   * Проверить наличие новых событий и при необходимости показать toast.
   * Безопасно вызывать при каждом renderMainScreen — не спамит.
   *
   * @param {object}   user               — текущий пользователь
   * @param {Function} onApprovalAction   — callback «Перейти к заявкам»
   */
  function checkAndNotify(user, onApprovalAction) {
    const pending = Credo.getPendingUsers().length;

    // Toast только при появлении НОВЫХ заявок, не на первый рендер
    if (_lastPendingCount >= 0 && pending > _lastPendingCount) {
      const delta = pending - _lastPendingCount;
      showToast({
        type:        'approval',
        text:        delta === 1 ? 'Новая заявка на вступление' : `Новых заявок: ${delta}`,
        actionLabel: 'Посмотреть',
        onAction:    onApprovalAction,
        duration:    5500,
      });
    }

    _lastPendingCount = pending;
  }

  /**
   * Сбросить in-memory состояние при смене пользователя.
   * Вызывать перед route() при переключении demo-юзера или logout.
   */
  function reset() {
    _lastPendingCount = -1;
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    markChatRead,
    getUnreadCount,
    getTotalUnread,
    checkAndNotify,
    showToast,
    reset,
  };

})();
