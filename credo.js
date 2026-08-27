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

  const CANONICAL_SCHOOL = 'Fiztex';
  const SCHOOL_ALIASES = {
    fiztex: CANONICAL_SCHOOL,
    fiztekh: CANONICAL_SCHOOL,
    phystech: CANONICAL_SCHOOL,
    'физтех': CANONICAL_SCHOOL,
  };

  function sanitizeSchoolName(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getCanonicalSchoolName(value) {
    const sanitized = sanitizeSchoolName(value);
    if (!sanitized) return '';
    return SCHOOL_ALIASES[sanitized.toLowerCase()] || sanitized;
  }

  // --------------- Доступ к данным ---------------

  function getUsers()    { return loadJSON('credo_users', []); }
  function saveUsers(u)  { saveJSON('credo_users', u); }

  function getRateLog()    { return loadJSON('credo_rate_log', []); }
  function saveRateLog(l)  { saveJSON('credo_rate_log', l); }

  function getChats()    { return loadJSON('credo_chats', {}); }
  function saveChats(c)  { saveJSON('credo_chats', c); }

  function getGroups()        { return loadJSON('credo_groups', []); }
  function saveGroups(groups) { saveJSON('credo_groups', groups); }

  function getGroupInvites()       { return loadJSON('credo_group_invites', []); }
  function saveGroupInvites(data)  { saveJSON('credo_group_invites', data); }

  function getGroupChats()      { return loadJSON('credo_group_chats', {}); }
  function saveGroupChats(data) { saveJSON('credo_group_chats', data); }

  function getUserBlocks() {
    const blocks = loadJSON('credo_user_blocks', []);
    return Array.isArray(blocks) ? blocks : [];
  }

  function saveUserBlocks(blocks) {
    saveJSON('credo_user_blocks', Array.isArray(blocks) ? blocks : []);
  }

  function getSettings() {
    const settings = loadJSON('credo_settings', {});
    return settings && typeof settings === 'object' ? settings : {};
  }

  function setSetting(key, value) {
    const settings = getSettings();
    settings[key] = value;
    saveJSON('credo_settings', settings);
    return settings;
  }

  function getSetting(key, fallback = null) {
    const settings = getSettings();
    return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
  }

  function hasSeenOnboarding() {
    return localStorage.getItem('fcom_onboarding_seen_v1') === 'true';
  }

  function setOnboardingSeen(seen = true) {
    if (seen) localStorage.setItem('fcom_onboarding_seen_v1', 'true');
    else localStorage.removeItem('fcom_onboarding_seen_v1');
  }

  function getBlockedUserIds(userId) {
    const ids = new Set();
    if (!userId) return ids;
    getUserBlocks().forEach((block) => {
      if (block.blockerId === userId && block.blockedId) ids.add(block.blockedId);
      if (block.blockedId === userId && block.blockerId) ids.add(block.blockerId);
    });
    return ids;
  }

  function isUserBlockedFor(firstUserId, secondUserId) {
    if (!firstUserId || !secondUserId) return false;
    return getBlockedUserIds(firstUserId).has(secondUserId);
  }

  function blockUserLocal(blockerId, blockedId) {
    if (!blockerId || !blockedId || blockerId === blockedId) {
      return { ok: false, error: 'invalid_block_target' };
    }

    const blocks = getUserBlocks();
    const exists = blocks.some((block) =>
      block.blockerId === blockerId && block.blockedId === blockedId,
    );

    if (!exists) {
      blocks.push({
        blockerId,
        blockedId,
        createdAt: new Date().toISOString(),
        user: getUserById(blockedId),
      });
      saveUserBlocks(blocks);
    }

    return { ok: true, blocks: getUserBlocks() };
  }

  function unblockUserLocal(blockerId, blockedId) {
    if (!blockerId || !blockedId) return { ok: false, error: 'invalid_block_target' };
    const next = getUserBlocks().filter((block) =>
      !(block.blockerId === blockerId && block.blockedId === blockedId),
    );
    saveUserBlocks(next);
    return { ok: true, blocks: next };
  }

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

  function keepOnlyDeviceAccount(id) {
    if (!id) return;
    saveJSON('credo_device_accounts', [id]);
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
    const canonicalSchool = getCanonicalSchoolName(school);

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
      school: canonicalSchool,
      grade,
      nickname,
      role: 'member',
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

  function migrateSchoolsToFiztex() {
    const users = getUsers();
    let usersChanged = false;
    users.forEach((user) => {
      if (user.school !== CANONICAL_SCHOOL) {
        user.school = CANONICAL_SCHOOL;
        usersChanged = true;
      }
    });
    if (usersChanged) saveUsers(users);

    const groups = getGroups();
    let groupsChanged = false;
    groups.forEach((group) => {
      if (group.school !== CANONICAL_SCHOOL) {
        group.school = CANONICAL_SCHOOL;
        groupsChanged = true;
      }
      if (group.type === 'school_public' && group.name !== CANONICAL_SCHOOL) {
        group.name = CANONICAL_SCHOOL;
        groupsChanged = true;
      }
      if (Array.isArray(group.members)) {
        group.members.forEach((member) => {
          if (member.school !== CANONICAL_SCHOOL) {
            member.school = CANONICAL_SCHOOL;
            groupsChanged = true;
          }
        });
      }
    });
    if (groupsChanged) saveGroups(groups);

    const invites = getGroupInvites();
    let invitesChanged = false;
    invites.forEach((invite) => {
      if (!invite.group) return;
      if (invite.group.school !== CANONICAL_SCHOOL) {
        invite.group.school = CANONICAL_SCHOOL;
        invitesChanged = true;
      }
      if (invite.group.type === 'school_public' && invite.group.name !== CANONICAL_SCHOOL) {
        invite.group.name = CANONICAL_SCHOOL;
        invitesChanged = true;
      }
    });
    if (invitesChanged) saveGroupInvites(invites);
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

  function sendMessage(fromId, toId, text, extra) {
    if (isUserBlockedFor(fromId, toId)) return { ok: false, error: 'user_blocked' };
    extra = extra || {};
    const chats = getChats();
    const key = chatKey(fromId, toId);
    if (!chats[key]) chats[key] = [];
    chats[key].push({
      id: extra.id || generateId(),
      from: fromId,
      to: toId,
      groupId: null,
      text,
      type: extra.type || (extra.attachmentPath ? 'image' : 'text'),
      attachmentPath: extra.attachmentPath || null,
      attachmentUrl: extra.attachmentUrl || null,
      attachmentMime: extra.attachmentMime || null,
      attachmentBytes: extra.attachmentBytes || null,
      attachmentWidth: extra.attachmentWidth || null,
      attachmentHeight: extra.attachmentHeight || null,
      time: extra.time || new Date().toISOString(),
      readAt: null,
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

  function getGroupById(groupId) {
    return getGroups().find(group => group.id === groupId) || null;
  }

  function getGroupMessages(groupId) {
    const chats = getGroupChats();
    return chats[groupId] || [];
  }

  function sendGroupMessage(groupId, fromId, text, extra) {
    extra = extra || {};
    const chats = getGroupChats();
    if (!chats[groupId]) chats[groupId] = [];
    chats[groupId].push({
      id: extra.id || generateId(),
      from: fromId,
      to: null,
      groupId,
      text,
      type: extra.type || (extra.attachmentPath ? 'image' : 'text'),
      attachmentPath: extra.attachmentPath || null,
      attachmentUrl: extra.attachmentUrl || null,
      attachmentMime: extra.attachmentMime || null,
      attachmentBytes: extra.attachmentBytes || null,
      attachmentWidth: extra.attachmentWidth || null,
      attachmentHeight: extra.attachmentHeight || null,
      time: extra.time || new Date().toISOString(),
      readAt: null,
    });
    saveGroupChats(chats);
  }

  function createGroup(name, school, creatorId, memberIds) {
    const creator = getUserById(creatorId);
    if (!creator) return { ok: false, error: 'creator_not_found' };

    const group = {
      id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name,
      school,
      type: 'private',
      createdBy: creatorId,
      createdAt: new Date().toISOString(),
      members: [{
        id: creator.id,
        nickname: creator.nickname,
        fullName: creator.fullName,
        school: creator.school,
        status: creator.status,
        avatarUrl: creator.avatarUrl || null,
        role: 'admin',
      }],
      memberCount: 1,
      myRole: 'admin',
      canManage: true,
    };

    const groups = getGroups();
    groups.push(group);
    saveGroups(groups);

    const invites = getGroupInvites();
    (memberIds || []).forEach((memberId) => {
      const invitedUser = getUserById(memberId);
      if (!invitedUser || invitedUser.id === creatorId) return;
      if (isUserBlockedFor(creatorId, invitedUser.id)) return;
      invites.push({
        id: 'gi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        createdAt: new Date().toISOString(),
        group: {
          id: group.id,
          name: group.name,
          school: group.school,
          type: group.type,
        },
        invitedBy: {
          id: creator.id,
          nickname: creator.nickname,
          fullName: creator.fullName,
        },
        invitedUserId: invitedUser.id,
      });
    });
    saveGroupInvites(invites);

    return { ok: true, group };
  }

  function respondGroupInvite(inviteId, currentUserId, decision) {
    const invites = getGroupInvites();
    const inviteIndex = invites.findIndex((invite) => invite.id === inviteId);
    if (inviteIndex === -1) return { ok: false, error: 'invite_not_found' };

    const invite = invites[inviteIndex];
    if (invite.invitedUserId && invite.invitedUserId !== currentUserId) {
      return { ok: false, error: 'forbidden' };
    }

    invites.splice(inviteIndex, 1);
    saveGroupInvites(invites);

    if (decision !== 'accept') return { ok: true };

    const groups = getGroups();
    const group = groups.find((item) => item.id === invite.group?.id);
    const user = getUserById(currentUserId);
    if (!group || !user) return { ok: false, error: 'group_not_found' };

    if (!Array.isArray(group.members)) group.members = [];
    if (!group.members.some((member) => member.id === currentUserId)) {
      group.members.push({
        id: user.id,
        nickname: user.nickname,
        fullName: user.fullName,
        school: user.school,
        status: user.status,
        avatarUrl: user.avatarUrl || null,
        role: 'member',
      });
      group.memberCount = group.members.length;
    }
    saveGroups(groups);

    return { ok: true, group };
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
    if (isUserBlockedFor(fromId, toId)) return { ok: false, reason: 'user_blocked' };

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
    if (!user) return [];
    const blockedIds = getBlockedUserIds(userId);
    return user.chats.filter((id) => !blockedIds.has(id));
  }

  // --------------- Полный сброс (для демо) ---------------

  function resetAll() {
    localStorage.removeItem('credo_users');
    localStorage.removeItem('credo_rate_log');
    localStorage.removeItem('credo_chats');
    localStorage.removeItem('credo_groups');
    localStorage.removeItem('credo_group_invites');
    localStorage.removeItem('credo_group_chats');
    localStorage.removeItem('credo_user_blocks');
    localStorage.removeItem('credo_user_reports');
    localStorage.removeItem('credo_settings');
    localStorage.removeItem('fcom_onboarding_seen_v1');
    localStorage.removeItem('credo_device_accounts');
    localStorage.removeItem('credo_blocked');
    localStorage.removeItem('credo_current_user');
  }

  // --------------- Публичный API ---------------

  migrateSchoolsToFiztex();

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

    // Регистрация
    registerUser,
    approveUser,
    rejectUser,

    // Чаты
    getChatMessages,
    sendMessage,
    getGroupMessages,
    sendGroupMessage,
    getGroups,
    getGroupById,
    getGroupInvites,
    getUserBlocks,
    saveUserBlocks,
    getSettings,
    setSetting,
    getSetting,
    hasSeenOnboarding,
    setOnboardingSeen,
    getBlockedUserIds,
    isUserBlockedFor,
    blockUserLocal,
    unblockUserLocal,
    createGroup,
    respondGroupInvite,
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
