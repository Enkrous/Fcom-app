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

'use strict';

const Credo = (() => {

  // --------------- Хелперы localStorage ---------------

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  function saveJSON(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  }

  // --------------- Доступ к данным ---------------

  function getUsers()    { return loadJSON('credo_users', []); }
  function saveUsers(u)  { saveJSON('credo_users', u); }

  function getRateLog()    { return loadJSON('credo_rate_log', []); }
  function saveRateLog(l)  { saveJSON('credo_rate_log', l); }

  function getChats()    { return loadJSON('credo_chats', {}); }
  function saveChats(c)  { saveJSON('credo_chats', c); }

  function getDeviceAccountIds() {
    const ids = loadJSON('credo_device_accounts', null);
    if (Array.isArray(ids) && ids.length > 0) {
      return [...new Set(ids)];
    }

    const currentUserId = getCurrentUserId();
    const derivedIds = getUsers()
      .filter(u => Boolean(u.passwordHash) || u.id === currentUserId)
      .map(u => u.id);

    if (derivedIds.length > 0) {
      saveJSON('credo_device_accounts', derivedIds);
    }

    return derivedIds;
  }

  function markDeviceAccount(id) {
    if (!id) return;
    const ids = new Set(getDeviceAccountIds());
    ids.add(id);
    saveJSON('credo_device_accounts', [...ids]);
  }

  function isDeviceBlocked() {
    return localStorage.getItem('credo_blocked') === 'true';
  }

  function blockDevice() {
    localStorage.setItem('credo_blocked', 'true');
  }

  function getCurrentUserId() {
    return localStorage.getItem('credo_current_user');
  }

  function setCurrentUserId(id) {
    if (id) localStorage.setItem('credo_current_user', id);
    else localStorage.removeItem('credo_current_user');
  }

  function getUserById(id) {
    return getUsers().find(u => u.id === id) || null;
  }

  function getDeviceAccounts() {
    const deviceIds = new Set(getDeviceAccountIds());
    return getUsers().filter(u => deviceIds.has(u.id));
  }

  function updateUser(id, patch) {
    const users = getUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    Object.assign(users[idx], patch);
    saveUsers(users);
    return users[idx];
  }

  // --------------- Уникальный ID ---------------

  function generateId() {
    return 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  // --------------- Уровни Кредо ---------------

  const LEVELS = [
    { name: 'Новичок',     min: 0,  max: 4,  css: 'novice'  },
    { name: 'Знакомый',    min: 5,  max: 14, css: 'known'   },
    { name: 'Доверенный',  min: 15, max: 29, css: 'trusted' },
    { name: 'Свой',        min: 30, max: Infinity, css: 'own' },
  ];

  function getCredLevel(cred) {
    const c = Math.max(0, cred);
    return LEVELS.find(l => c >= l.min && c <= l.max) || LEVELS[0];
  }

  // Прогресс внутри текущего уровня (0..1), для шкалы
  function getCredProgress(cred) {
    const c = Math.max(0, cred);
    if (c >= 30) return 1;
    // Шкала от 0 до 40 (визуально)
    return Math.min(c / 40, 1);
  }

  // --------------- Регистрация ---------------

  function registerUser(fullName, school, grade, nickname) {
    if (isDeviceBlocked()) return { ok: false, error: 'device_blocked' };

    const users = getUsers();

    // Проверка: если на этом устройстве есть отклонённый пользователь — блокируем
    const hasRejected = users.some(u => u.status === 'rejected');
    if (hasRejected) {
      blockDevice();
      return { ok: false, error: 'device_blocked' };
    }

    const nicknameExists = users.some(
      u => u.nickname.toLowerCase() === nickname.toLowerCase()
    );
    if (nicknameExists) return { ok: false, error: 'nickname_taken' };

    // Если нет ни одного одобренного — первый пользователь одобряется автоматически
    const hasApproved = users.some(u => u.status === 'approved');

    const user = {
      id: generateId(),
      fullName,
      school,
      grade,
      nickname,
      status: hasApproved ? 'pending' : 'approved',
      cred: hasApproved ? 0 : 1,
      ratings: [],
      chats: [],
      createdAt: new Date().toISOString(),
    };

    users.push(user);
    saveUsers(users);
    setCurrentUserId(user.id);
    markDeviceAccount(user.id);

    return { ok: true, user };
  }

  // --------------- Одобрение / Отклонение ---------------

  function approveUser(userId) {
    const user = updateUser(userId, { status: 'approved', cred: 1 });
    return user;
  }

  function rejectUser(userId) {
    const user = updateUser(userId, { status: 'rejected' });
    return user;
  }

  // --------------- Система чатов (имитация) ---------------

  /** Ключ чата — отсортированные id */
  function chatKey(id1, id2) {
    return [id1, id2].sort().join('::');
  }

  function getChatMessages(id1, id2) {
    const chats = getChats();
    return chats[chatKey(id1, id2)] || [];
  }

  function sendMessage(fromId, toId, text) {
    const chats = getChats();
    const key = chatKey(fromId, toId);
    if (!chats[key]) chats[key] = [];
    chats[key].push({
      from: fromId,
      text,
      time: new Date().toISOString(),
    });
    saveChats(chats);

    // Обновить список чатов у обоих участников
    const users = getUsers();
    [fromId, toId].forEach(uid => {
      const u = users.find(x => x.id === uid);
      if (u && !u.chats.includes(uid === fromId ? toId : fromId)) {
        u.chats.push(uid === fromId ? toId : fromId);
      }
    });
    saveUsers(users);
  }

  /** Проверяет, был ли диалог между двумя пользователями */
  function hadConversation(id1, id2) {
    const msgs = getChatMessages(id1, id2);
    return msgs.length > 0;
  }

  // --------------- Оценка: базовая дельта ---------------

  const SCORE_DELTA = { 1: -2, 2: -1, 3: 0, 4: 1, 5: 2 };

  function calculateCredDelta(score) {
    return SCORE_DELTA[score] ?? 0;
  }

  // --------------- Вес оценки (анти-накрутка) ---------------

  /**
   * Возвращает коэффициент веса оценки.
   * @param {number} raterCred — текущее Кредо оценивающего
   * @param {number} timesRatedSameUser — сколько раз оценивающий уже оценивал этого пользователя
   */
  function getWeight(raterCred, timesRatedSameUser) {
    let credWeight;
    if (raterCred < 5)       credWeight = 0.3;
    else if (raterCred < 15) credWeight = 0.7;
    else                     credWeight = 1.0;

    // Затухание повторных оценок: каждый повтор уменьшает вес на 20%
    const repeatDecay = Math.max(0.2, Math.pow(0.8, timesRatedSameUser));

    return +(credWeight * repeatDecay).toFixed(3);
  }

  // --------------- Дневной лимит (анти-скачки) ---------------

  const MAX_DAILY_CHANGE = 5;

  /** Суммарное изменение cred за последние 24 часа */
  function getDailyCredChange(userId) {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const user = getUserById(userId);
    if (!user) return 0;

    return user.ratings
      .filter(r => new Date(r.date).getTime() > dayAgo)
      .reduce((sum, r) => sum + (r.effectiveDelta || 0), 0);
  }

  function clampCredChange(userId, proposedDelta) {
    const alreadyChanged = getDailyCredChange(userId);
    const remaining = MAX_DAILY_CHANGE - Math.abs(alreadyChanged);

    if (remaining <= 0) return 0;

    if (proposedDelta > 0) return Math.min(proposedDelta, remaining);
    if (proposedDelta < 0) return Math.max(proposedDelta, -remaining);
    return 0;
  }

  // --------------- Проверка: можно ли оценить ---------------

  function canRate(fromId, toId) {
    if (fromId === toId) return { ok: false, reason: 'self' };

    if (!hadConversation(fromId, toId)) {
      return { ok: false, reason: 'no_chat' };
    }

    // Проверка 24-часового ограничения
    const log = getRateLog();
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const recent = log.find(
      r => r.from === fromId && r.to === toId && new Date(r.date).getTime() > dayAgo
    );
    if (recent) return { ok: false, reason: '24h_limit' };

    return { ok: true };
  }

  // --------------- Основная функция оценки ---------------

  function rateUser(fromId, toId, score) {
    // Валидация
    if (score < 1 || score > 5 || !Number.isInteger(score)) {
      return { ok: false, error: 'invalid_score' };
    }

    const check = canRate(fromId, toId);
    if (!check.ok) return { ok: false, error: check.reason };

    const rater = getUserById(fromId);
    const target = getUserById(toId);
    if (!rater || !target) return { ok: false, error: 'user_not_found' };

    // Сколько раз этот человек уже оценивал данного пользователя
    const log = getRateLog();
    const timesRated = log.filter(r => r.from === fromId && r.to === toId).length;

    const weight = getWeight(rater.cred, timesRated);
    const baseDelta = calculateCredDelta(score);
    const rawDelta = +(baseDelta * weight).toFixed(2);
    const effectiveDelta = clampCredChange(toId, rawDelta);

    // Запись в лог
    const entry = {
      from: fromId,
      to: toId,
      score,
      weight,
      baseDelta,
      effectiveDelta,
      date: new Date().toISOString(),
    };

    log.push(entry);
    saveRateLog(log);

    // Обновить ratings и cred целевого пользователя
    const users = getUsers();
    const ti = users.findIndex(u => u.id === toId);
    users[ti].ratings.push(entry);
    users[ti].cred = Math.max(0, +(users[ti].cred + effectiveDelta).toFixed(2));
    saveUsers(users);

    return { ok: true, entry, newCred: users[ti].cred };
  }

  // --------------- Списки пользователей ---------------

  function getPendingUsers() {
    return getUsers().filter(u => u.status === 'pending');
  }

  function getApprovedUsers() {
    return getUsers().filter(u => u.status === 'approved');
  }

  /**
   * Пользователи, которых текущий может оценить:
   * - был диалог
   * - не оценивал за последние 24ч
   */
  function getUsersToRate(fromId) {
    const approved = getApprovedUsers().filter(u => u.id !== fromId);
    return approved.filter(u => {
      const check = canRate(fromId, u.id);
      return check.ok;
    });
  }

  /**
   * История полученных оценок пользователя (последние 50)
   */
  function getRateHistory(userId) {
    const user = getUserById(userId);
    if (!user) return [];
    return [...user.ratings].reverse().slice(0, 50);
  }

  /**
   * Список собеседников (id), с которыми были чаты
   */
  function getChatPartners(userId) {
    const user = getUserById(userId);
    return user ? user.chats : [];
  }

  // --------------- Полный сброс (для демо) ---------------

  function resetAll() {
    localStorage.removeItem('credo_users');
    localStorage.removeItem('credo_rate_log');
    localStorage.removeItem('credo_chats');
    localStorage.removeItem('credo_device_accounts');
    localStorage.removeItem('credo_blocked');
    localStorage.removeItem('credo_current_user');
  }

  // --------------- Публичный API ---------------

  return {
    // Данные
    updateUser,
    getUsers,
    getDeviceAccounts,
    getUserById,
    getCurrentUserId,
    setCurrentUserId,
    markDeviceAccount,
    isDeviceBlocked,
    blockDevice,

    // Регистрация
    registerUser,
    approveUser,
    rejectUser,

    // Чаты
    getChatMessages,
    sendMessage,
    hadConversation,
    chatKey,

    // Оценки
    canRate,
    rateUser,
    calculateCredDelta,
    getWeight,
    clampCredChange,

    // Списки
    getPendingUsers,
    getApprovedUsers,
    getUsersToRate,
    getRateHistory,
    getChatPartners,

    // Уровни
    getCredLevel,
    getCredProgress,
    LEVELS,

    // Утилиты
    resetAll,
    generateId,
  };

})();
