/**
 * app.js — UI-логика приложения «Кредо»
 *
 * Управляет переключением экранов, формами, рендерингом списков,
 * имитацией чатов и демо-переключателем пользователей.
 */

'use strict';

const App = (() => {

  // --------------- DOM-элементы ---------------

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const appShell = $('#app-shell');
  const landingShell = $('#landing-shell');
  const landingFrame = $('#landing-frame');

  const screens = {
    onboarding:   $('#screen-onboarding'),
    setPassword:  $('#screen-set-password'),
    login:        $('#screen-login'),
    blocked:      $('#screen-blocked'),
    register:     $('#screen-register'),
    pending:      $('#screen-pending'),
    main:         $('#screen-main'),
    rate:         $('#screen-rate'),
    chat:         $('#screen-chat'),
    settings:     $('#screen-settings'),
    verifyPhone:  $('#screen-verify-phone'),
    userProfile:  $('#screen-user-profile'),
  };

  // Текущее состояние
  let currentChatPartner = null;
  let currentChatGroup   = null;
  let currentProfileUser = null;
  let _profileReturnState = null;
  let _adminStatsRequest = 0;
  let pendingRatings  = {};  // { toId: score }
  let _pendingPhone   = '';  // phone waiting for OTP confirmation
  let _pendingChatImage = null;
  let _onboardingIndex = 0;
  let _onboardingNextScreen = 'register';
  let _safetyTargetUserId = null;
  let _safetyMode = 'report';

  const ONBOARDING_STEPS = [
    {
      kicker: 'Fcom',
      title: 'Общайтесь внутри своей школы',
      text: 'Профили, чаты и школьные группы открываются только после модерации аккаунта.',
    },
    {
      kicker: 'Credo',
      title: 'Репутация растет от реальных взаимодействий',
      text: 'Оценки доступны после диалога, а лимиты защищают рейтинг от накрутки.',
    },
    {
      kicker: 'Безопасность',
      title: 'Жалобы и блокировки под рукой',
      text: 'Можно пожаловаться на участника, заблокировать личные сообщения и снять блокировку в настройках.',
    },
  ];

  const REPORT_REASON_LABELS = {
    spam: 'Спам',
    harassment: 'Оскорбления или травля',
    fake_account: 'Фейковый аккаунт',
    inappropriate_content: 'Неподходящий контент',
    other: 'Другое',
  };

  // Presence: таймеры
  let _typingDebounceTimer  = null;  // debounce «печатает»
  let _presenceListInterval = null;  // обновление точек в списке чатов

  // Поиск: текущие запросы (сохраняются при переключении вкладок)
  let _chatSearchQuery   = '';
  let _memberSearchQuery = '';
  let _appVisible = false;
  let _currentScreen = '';
  let _activeTab = 'chats';

  function _setDemoMenuOpen(open) {
    const wrap = $('#demo-bar .demo-select-wrap');
    const menu = $('#demo-user-menu');
    const trigger = $('#demo-user-trigger');
    if (!wrap || !menu || !trigger) return;

    wrap.classList.toggle('is-open', open);
    menu.classList.toggle('hidden', !open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function _getDemoUserMeta(status, isCurrent) {
    if (isCurrent) return 'Активный пользователь';
    if (status === 'pending') return 'Заявка ожидает одобрения';
    if (status === 'rejected') return 'Доступ отклонен';
    return 'Одобренный участник';
  }

  function _renderDemoMenu(users, currentId) {
    const menu = $('#demo-user-menu');
    const triggerLabel = $('#demo-user-trigger-label');
    if (!menu || !triggerLabel) return;

    const currentUser = users.find((user) => user.id === currentId) || null;
    triggerLabel.textContent = currentUser ? `@${currentUser.nickname}` : 'Выберите пользователя';

    const options = [{
      id: '',
      title: 'Без активного пользователя',
      meta: 'Открыть вход или регистрацию',
      isActive: !currentId,
    }].concat(users.map((user) => ({
      id: user.id,
      title: `@${user.nickname}`,
      meta: _getDemoUserMeta(user.status, user.id === currentId),
      isActive: user.id === currentId,
    })));

    menu.innerHTML = options.map((option) => `
      <button
        class="demo-select-option${option.isActive ? ' is-active' : ''}"
        type="button"
        role="option"
        data-demo-user-value="${escapeAttr(option.id)}"
        aria-selected="${option.isActive ? 'true' : 'false'}"
      >
        <span class="demo-option-title">${escapeHtml(option.title)}</span>
        <span class="demo-option-meta">${escapeHtml(option.meta)}</span>
      </button>
    `).join('');

    menu.querySelectorAll('[data-demo-user-value]').forEach((button) => {
      button.addEventListener('click', () => {
        handleDemoSwitch(button.dataset.demoUserValue);
        _setDemoMenuOpen(false);
      });
    });
  }

  function setAppVisible(visible) {
    _appVisible = Boolean(visible);
    if (appShell) appShell.classList.toggle('hidden', !_appVisible);
    if (landingShell) landingShell.classList.toggle('hidden', _appVisible);
    document.body.classList.toggle('app-open', _appVisible);

    const demoBar = $('#demo-bar');
    if (!_appVisible && demoBar) {
      demoBar.classList.add('hidden');
      _setDemoMenuOpen(false);
    }
  }

  function _getLocalAccounts() {
    return Credo.getDeviceAccounts();
  }

  function _isBackendMode() {
    return typeof API !== 'undefined'
      && typeof API.isBackendEnabled === 'function'
      && API.isBackendEnabled();
  }

  function _isAdmin(user) {
    return user?.role === 'admin';
  }

  function _isBlockedPeer(userId) {
    const currentUserId = Credo.getCurrentUserId();
    return typeof Credo.isUserBlockedFor === 'function'
      && Credo.isUserBlockedFor(currentUserId, userId);
  }

  function _getVisibleApprovedUsers(currentUser) {
    const blockedIds = typeof Credo.getBlockedUserIds === 'function'
      ? Credo.getBlockedUserIds(currentUser.id)
      : new Set();
    return Credo.getApprovedUsers().filter((user) =>
      user.id !== currentUser.id && !blockedIds.has(user.id),
    );
  }

  function _safetyErrorMessage(error) {
    const messages = {
      user_blocked: 'Личные действия с этим участником недоступны из-за блокировки.',
      cannot_report_self: 'Нельзя пожаловаться на свой профиль.',
      cannot_block_self: 'Нельзя заблокировать свой профиль.',
      invalid_reason: 'Выберите причину жалобы.',
      details_too_long: 'Комментарий слишком длинный.',
      target_not_found: 'Участник не найден.',
      target_not_approved: 'Участник еще не одобрен.',
      cross_school_forbidden: 'Действие доступно только внутри вашей школы.',
      rate_limit_exceeded: 'Слишком много попыток. Попробуйте позже.',
      admin_only: 'Доступно только администратору.',
      forbidden: 'Недостаточно прав для этого действия.',
      network_error: 'Не удалось связаться с сервером.',
    };
    return messages[error] || ('Ошибка: ' + (error || 'unknown_error'));
  }

  function _enforceSingleAccountForRegularUser(user) {
    if (!user?.id || _isAdmin(user) || typeof Credo.keepOnlyDeviceAccount !== 'function') return;
    Credo.keepOnlyDeviceAccount(user.id);
  }

  function _syncDemoBarMode(user) {
    const demoBar = $('#demo-bar');
    const brand = $('#demo-brand');
    const resetBtn = $('#demo-reset-btn');
    const selectWrap = $('#demo-bar .demo-select-wrap');

    if (!demoBar) return;

    const isAdmin = _isAdmin(user);
    demoBar.classList.toggle('demo-bar--admin', isAdmin);
    demoBar.classList.toggle('demo-bar--user', Boolean(user) && !isAdmin);

    if (brand) brand.classList.toggle('hidden', !user || isAdmin);
    if (selectWrap) selectWrap.classList.toggle('hidden', !isAdmin);
    if (resetBtn) resetBtn.classList.toggle('hidden', !isAdmin);
  }

  function _isGroupChatOpen() {
    return Boolean(currentChatGroup);
  }

  function _getCurrentChatMessages(myId) {
    if (_isGroupChatOpen()) {
      return Credo.getGroupMessages(currentChatGroup);
    }
    if (!currentChatPartner) return [];
    return Credo.getChatMessages(myId, currentChatPartner);
  }

  // --------------- Навигация ---------------

  function showScreen(name) {
    _currentScreen = name;
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    if (screens[name]) screens[name].classList.remove('hidden');

    // Показать верхний бар только для активного пользователя.
    const demoBar = $('#demo-bar');
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    _syncDemoBarMode(currentUser);
    if (_appVisible && currentUser) {
      demoBar.classList.remove('hidden');
    } else {
      demoBar.classList.add('hidden');
    }

    // Остановить обновление статусов списка при выходе с главного экрана
    if (name !== 'main') _stopPresenceListUpdates();
  }

  function showTab(tabName) {
    _activeTab = tabName;
    $$('.tab-pane').forEach(t => t.classList.add('hidden'));
    const pane = $(`#tab-${tabName}`);
    if (pane) pane.classList.remove('hidden');

    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    const btn = $(`.nav-btn[data-tab="${tabName}"]`);
    if (btn) btn.classList.add('active');
  }

  function _shouldShowOnboarding() {
    return typeof Credo.hasSeenOnboarding === 'function' && !Credo.hasSeenOnboarding();
  }

  function openOnboarding(nextScreen = 'register') {
    _onboardingNextScreen = nextScreen;
    _onboardingIndex = 0;
    renderOnboardingStep();
    showScreen('onboarding');
  }

  function renderOnboardingStep() {
    const step = ONBOARDING_STEPS[_onboardingIndex] || ONBOARDING_STEPS[0];
    const kicker = $('#onboarding-kicker');
    const title = $('#onboarding-title');
    const text = $('#onboarding-text');
    const dots = $('#onboarding-dots');
    const next = $('#onboarding-next-btn');

    if (kicker) kicker.textContent = step.kicker;
    if (title) title.textContent = step.title;
    if (text) text.textContent = step.text;
    if (next) next.textContent = _onboardingIndex === ONBOARDING_STEPS.length - 1 ? 'Начать' : 'Дальше';
    if (dots) {
      dots.innerHTML = ONBOARDING_STEPS.map((_, index) =>
        `<span class="onboarding-dot${index === _onboardingIndex ? ' is-active' : ''}" aria-hidden="true"></span>`,
      ).join('');
    }
  }

  function completeOnboarding() {
    if (typeof Credo.setOnboardingSeen === 'function') {
      Credo.setOnboardingSeen(true);
    }
    showScreen(_onboardingNextScreen);
  }

  function handleOnboardingNext() {
    if (_onboardingIndex < ONBOARDING_STEPS.length - 1) {
      _onboardingIndex += 1;
      renderOnboardingStep();
      return;
    }
    completeOnboarding();
  }

  function renderPendingScreen(user) {
    $('#pending-nickname').textContent = `@${user.nickname}`;
    const card = screens.pending?.querySelector('.status-card');
    if (!card || card.querySelector('.status-steps')) return;

    const steps = document.createElement('div');
    steps.className = 'status-steps';
    steps.innerHTML = `
      <div class="status-step is-done"><strong>Профиль создан</strong><span>Заявка сохранена и ожидает проверки.</span></div>
      <div class="status-step is-active"><strong>Модерация</strong><span>Администратор проверит школу и данные профиля.</span></div>
      <div class="status-step"><strong>Пароль и вход</strong><span>После одобрения откроется создание пароля.</span></div>
    `;

    const homeButton = card.querySelector('[data-go-home]');
    if (homeButton) card.insertBefore(steps, homeButton);
    else card.appendChild(steps);
  }

  // --------------- Маршрутизация ---------------

  function route() {
    if (Credo.isDeviceBlocked()) {
      showScreen('blocked');
      return;
    }

    const userId = Credo.getCurrentUserId();

    // Нет текущего пользователя — показать логин (или регистрацию если нет пользователей)
    if (!userId) {
      const users = _getLocalAccounts();
      if (_appVisible && _shouldShowOnboarding()) {
        openOnboarding(_isBackendMode() ? 'login' : (users.length === 0 ? 'register' : 'login'));
        return;
      }
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
      renderPendingScreen(user);
      showScreen('pending');
      return;
    }

    // approved — проверяем наличие пароля
    if (user.status === 'approved' && !user.passwordHash) {
      $('#setpass-nickname').textContent = `@${user.nickname}`;
      showScreen('setPassword');
      return;
    }

    // Всё ок — главный экран
    showScreen('main');
    renderMainScreen(user);
    showTab('chats');
  }

  function openExperience(mode) {
    setAppVisible(true);

    if (mode === 'register') {
      if (Credo.isDeviceBlocked()) {
        showScreen('blocked');
        return;
      }

      const userId = Credo.getCurrentUserId();
      if (userId) {
        route();
        return;
      }

      if (_shouldShowOnboarding()) {
        openOnboarding('register');
        return;
      }

      showScreen('register');
      return;
    }

    if (mode === 'login') {
      if (Credo.isDeviceBlocked()) {
        showScreen('blocked');
        return;
      }

      const userId = Credo.getCurrentUserId();
      if (userId) {
        route();
        return;
      }

      if (_shouldShowOnboarding()) {
        openOnboarding('login');
        return;
      }

      if (!_isBackendMode() && _getLocalAccounts().length === 0) {
        showScreen('register');
        return;
      }

      showScreen('login');
      return;
    }

    route();
  }

  function openDashboardExperience() {
    openExperience('register');
  }

  function closeExperience() {
    clearTimeout(_typingDebounceTimer);
    _stopPresenceListUpdates();
    _setDemoMenuOpen(false);

    if (typeof Presence !== 'undefined') {
      if (currentChatPartner) {
        Presence.setTyping(Credo.getCurrentUserId(), currentChatPartner, false);
      }
      Presence.stopWatching();
    }

    currentChatPartner = null;
    currentChatGroup = null;
    _clearPendingChatImage();
    _resetChatStatus();
    setAppVisible(false);
  }

  function wireLandingFrame() {
    if (!landingFrame) return;

    const attachHandlers = () => {
      let doc;
      try {
        doc = landingFrame.contentDocument || landingFrame.contentWindow?.document;
      } catch {
        return;
      }

      if (!doc) return;

      const registrationBtn = doc.querySelector('.hero-copy .cta-row .primary-button');
      if (registrationBtn && !registrationBtn.dataset.dashboardBound) {
        registrationBtn.dataset.dashboardBound = 'true';
        registrationBtn.addEventListener('click', (event) => {
          event.preventDefault();
          openExperience('register');
        });
      }
    };

    landingFrame.addEventListener('load', attachHandlers);
    if (landingFrame.contentDocument?.readyState === 'complete') {
      attachHandlers();
    }
  }

  // --------------- Главный экран ---------------

  function renderMainScreen(user) {
    if (!user) return;
    _enforceSingleAccountForRegularUser(user);

    // Запустить отслеживание активности текущего пользователя
    if (typeof Presence !== 'undefined') {
      Presence.startActivityTracking(user.id);
    }

    const level = Credo.getCredLevel(user.cred);

    // Приветствие
    $('#main-greeting').textContent = `Привет, ${user.nickname}`;
    $('#main-cred-value').textContent = user.cred;
    $('#main-cred-level').textContent = level.name;

    // Подкрасить бейдж Кредо в цвет уровня
    $('#main-cred-badge').className = `cred-badge ${level.css}`;

    // Уведомление об оценке (type-класс для визуального различия)
    const toRate = Credo.getUsersToRate(user.id);
    const notif = $('#rate-notification');
    if (toRate.length > 0) {
      notif.classList.remove('hidden');
      notif.classList.add('notification--rate');
    } else {
      notif.classList.add('hidden');
      notif.classList.remove('notification--rate');
    }

    renderChatList(user);
    renderGroupList(user);
    renderUsersTab(user);
    renderProfileTab(user);
    _syncAdminNavigation(user);
    if (_isAdmin(user)) {
      renderAdminTab();
    }

    // Обновить badges и проверить новые события
    _updateNavBadges(user);
    if (_isAdmin(user) && typeof Notif !== 'undefined') {
      Notif.checkAndNotify(user, () => showTab('users'));
    }
  }

  function _syncAdminNavigation(user) {
    const adminBtn = $('#nav-admin-btn');
    if (!adminBtn) return;

    const isAdmin = _isAdmin(user);
    adminBtn.classList.toggle('hidden', !isAdmin);
    if (!isAdmin && _activeTab === 'admin') {
      showTab('chats');
    }
  }

  /**
   * Обновить счётчики на кнопках навигации.
   * Вызывать после любого изменения чатов или состава участников.
   */
  function _updateNavBadges(user) {
    if (typeof Notif === 'undefined') return;
    _setBadge('badge-chats', Notif.getTotalUnread(user.id));
    const approvalCount = _isAdmin(user) ? Credo.getPendingUsers().length : 0;
    _setBadge('badge-users', approvalCount + Credo.getGroupInvites().length);
  }

  function _setBadge(id, count) {
    const el = $('#' + id);
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.removeAttribute('hidden');
      el.classList.add('nav-badge--visible');
    } else {
      el.textContent = '';
      el.classList.remove('nav-badge--visible');
    }
  }

  // --------------- Список чатов ---------------

  function renderChatList(currentUser) {
    const container = $('#chat-list');
    const query = _chatSearchQuery.trim().toLowerCase();
    let approved = _getVisibleApprovedUsers(currentUser);

    if (query) {
      approved = approved.filter(u =>
        u.nickname.toLowerCase().includes(query) ||
        (u.fullName && u.fullName.toLowerCase().includes(query))
      );
    }

    approved = approved
      .map((user) => {
        const messages = Credo.getChatMessages(currentUser.id, user.id);
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        return {
          user,
          messages,
          lastMessage,
          lastActivity: lastMessage ? new Date(lastMessage.time).getTime() : 0,
        };
      })
      .sort((a, b) => {
        if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
        return a.user.nickname.localeCompare(b.user.nickname, 'ru');
      });

    if (approved.length === 0) {
      container.innerHTML = query
        ? _searchEmptyHTML(query)
        : '<p class="hint">Нет одобренных участников для чата</p>';
      _stopPresenceListUpdates();
      return;
    }

    container.innerHTML = approved.map(({ user, messages, lastMessage }) => {
      const level   = Credo.getCredLevel(user.cred);
      const msgs    = messages;
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1].text : 'Нет сообщений';
      const unread  = typeof Notif !== 'undefined'
        ? Notif.getUnreadCount(currentUser.id, user.id) : 0;

      return `
        <div class="card chat-card" data-user-id="${escapeAttr(user.id)}">
          <button class="profile-link-btn" type="button" data-open-user-profile="${escapeAttr(user.id)}">
            ${Avatar.html({ seed: user.nickname, imageUrl: user.avatarUrl || '' })}
          </button>
          <div class="card-body">
            <div class="card-name">
              <button class="profile-link-btn profile-link-card" type="button" data-open-user-profile="${escapeAttr(user.id)}">
                <span class="profile-link-text">${escapeHtml(user.nickname || '')}</span>
              </button>
              <span class="level-badge ${escapeAttr(level.css)}">${escapeHtml(level.name)}</span>
            </div>
            <div class="card-sub">
              <span class="card-user-status" data-status-for="${escapeAttr(user.id)}"></span><span class="card-last-msg">${escapeHtml(truncate(lastMsg, msgs.length > 0 ? 36 : 44))}</span>
            </div>
          </div>
          ${unread > 0 ? `<span class="chat-unread-count">${escapeHtml(String(unread > 99 ? '99+' : unread))}</span>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('.chat-card').forEach(card => {
      card.addEventListener('click', () => {
        openChat(card.dataset.userId);
      });
    });

    container.querySelectorAll('[data-open-user-profile]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openUserProfile(button.dataset.openUserProfile, { type: 'main', tab: 'chats' });
      });
    });

    // Немедленно показать текущие статусы, затем запустить обновление
    _updatePresenceList();
    _startPresenceListUpdates();
  }

  function renderGroupList(currentUser) {
    const container = $('#group-list');
    const empty = $('#group-list-empty');
    const query = _chatSearchQuery.trim().toLowerCase();
    let groups = Credo.getGroups();

    if (query) {
      groups = groups.filter((group) =>
        group.name.toLowerCase().includes(query) ||
        (group.school && group.school.toLowerCase().includes(query))
      );
    }

    groups = groups
      .map((group) => {
        const messages = Credo.getGroupMessages(group.id);
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        return {
          group,
          lastMessage,
          lastActivity: lastMessage ? new Date(lastMessage.time).getTime() : 0,
        };
      })
      .sort((a, b) => {
        if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
        return a.group.name.localeCompare(b.group.name, 'ru');
      });

    if (groups.length === 0) {
      container.innerHTML = '';
      empty.textContent = query
        ? `Ничего не найдено по «${query}»`
        : 'Пока нет доступных групп.';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    container.innerHTML = groups.map(({ group, lastMessage }) => {
      const lastMsg = lastMessage
        ? _messagePreview(lastMessage)
        : (group.type === 'school_public' ? 'Публичная группа школы' : 'Закрытая группа по приглашениям');

      return `
        <div class="card chat-card" data-group-id="${escapeAttr(group.id)}">
          ${Avatar.html({ seed: group.name, imageUrl: group.avatarUrl || '', chars: 2 })}
          <div class="card-body">
            <div class="card-name">${escapeHtml(group.name || '')}
              <span class="level-badge ${escapeAttr(group.type === 'school_public' ? 'known' : 'trusted')}">${escapeHtml(group.type === 'school_public' ? 'School' : 'Group')}</span>
            </div>
            <div class="card-sub">${escapeHtml(lastMsg)}</div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-group-id]').forEach((card) => {
      card.addEventListener('click', () => openGroupChat(card.dataset.groupId));
    });
  }

  /** Обновить онлайн-точки и статус-текст в списке чатов (без перерисовки). */
  function _updatePresenceList() {
    if (typeof Presence === 'undefined') return;

    document.querySelectorAll('.card-user-status[data-status-for]').forEach(el => {
      const userId = el.dataset.statusFor;
      const avatar = el.closest('.chat-card')?.querySelector('.card-avatar');
      const online   = Presence.isOnline(userId);
      const lastSeen = Presence.getLastSeen(userId);

      if (avatar) avatar.classList.toggle('avatar-online', online);

      if (online) {
        el.textContent = 'онлайн · ';
        el.className = 'card-user-status online';
      } else if (lastSeen) {
        el.textContent = Presence.formatLastSeen(lastSeen) + ' · ';
        el.className = 'card-user-status lastseen';
      } else {
        el.textContent = '';
        el.className = 'card-user-status';
      }
    });
  }

  function _startPresenceListUpdates() {
    _stopPresenceListUpdates();
    if (typeof Presence === 'undefined') return;
    _presenceListInterval = setInterval(_updatePresenceList, 2000);
  }

  function _stopPresenceListUpdates() {
    clearInterval(_presenceListInterval);
    _presenceListInterval = null;
  }

  function _messagePreview(message) {
    if (!message) return 'Нет сообщений';
    if (message.type === 'image') {
      return message.text ? `Фото · ${message.text}` : 'Фото';
    }
    return message.text || 'Нет сообщений';
  }

  // --------------- Вкладка «Пользователи» ---------------

  function renderUsersTab(currentUser) {
    const isAdmin = _isAdmin(currentUser);

    // Заявки
    const pending = isAdmin ? Credo.getPendingUsers() : [];
    const pendingList = $('#pending-list');
    const pendingEmpty = $('#pending-empty');

    if (pending.length === 0) {
      pendingList.innerHTML = '';
      pendingEmpty.textContent = isAdmin
        ? 'Новых заявок пока нет.'
        : 'Новые заявки могут одобрять только администраторы.';
      pendingEmpty.classList.remove('hidden');
    } else {
      pendingEmpty.classList.add('hidden');
      pendingList.innerHTML = pending.map(u => `
        <div class="card">
          ${Avatar.html({ seed: u.nickname, imageUrl: u.avatarUrl || '' })}
          <div class="card-body">
            <div class="card-name">${escapeHtml(u.fullName || '')}</div>
            <div class="card-sub">@${escapeHtml(u.nickname || '')} · ${escapeHtml(u.school || '')} · ${escapeHtml(u.grade || '')}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn-success btn-small" data-approve="${escapeAttr(u.id)}">Одобрить</button>
            <button class="btn btn-danger btn-small" data-reject="${escapeAttr(u.id)}">Отклонить</button>
          </div>
        </div>`).join('');

      pendingList.querySelectorAll('[data-approve]').forEach(btn => {
        btn.addEventListener('click', () => {
          Credo.approveUser(btn.dataset.approve);
          refreshAll();
        });
      });
      pendingList.querySelectorAll('[data-reject]').forEach(btn => {
        btn.addEventListener('click', () => {
          Credo.rejectUser(btn.dataset.reject);
          refreshAll();
        });
      });
    }

    // Участники
    const memberQuery = _memberSearchQuery.trim().toLowerCase();
    let members = _getVisibleApprovedUsers(currentUser);

    if (memberQuery) {
      members = members.filter(u =>
        u.nickname.toLowerCase().includes(memberQuery) ||
        (u.fullName && u.fullName.toLowerCase().includes(memberQuery))
      );
    }

    const membersList = $('#members-list');
    const membersEmpty = $('#members-empty');

    if (members.length === 0) {
      if (memberQuery) {
        // Есть запрос, но ничего не найдено — empty state внутри списка
        membersList.innerHTML = _searchEmptyHTML(memberQuery);
        membersEmpty.classList.add('hidden');
      } else {
        membersList.innerHTML = '';
        membersEmpty.classList.remove('hidden');
      }
    } else {
      membersEmpty.classList.add('hidden');
      membersList.innerHTML = members.map(u => {
        const level = Credo.getCredLevel(u.cred);
        return `
          <div class="card">
            <button class="profile-link-btn" type="button" data-open-member-profile="${escapeAttr(u.id)}">
              ${Avatar.html({ seed: u.nickname, imageUrl: u.avatarUrl || '' })}
            </button>
            <div class="card-body">
              <div class="card-name">
                <button class="profile-link-btn profile-link-card" type="button" data-open-member-profile="${escapeAttr(u.id)}">
                  <span class="profile-link-text">${escapeHtml(u.nickname || '')}</span>
                </button>
                <span class="level-badge ${escapeAttr(level.css)}">${escapeHtml(level.name)}</span>
              </div>
              <div class="card-sub">${escapeHtml(u.fullName || '')} · Кредо: ${escapeHtml(String(u.cred ?? 0))}</div>
            </div>
            <div class="card-actions">
              <button class="btn btn-outline btn-small" type="button" data-open-member-profile="${escapeAttr(u.id)}">Профиль</button>
              <button class="btn btn-small" type="button" data-open-chat="${escapeAttr(u.id)}">Chat</button>
            </div>
          </div>`;
      }).join('');

      membersList.querySelectorAll('[data-open-chat]').forEach(button => {
        button.addEventListener('click', () => openChat(button.dataset.openChat));
      });
      membersList.querySelectorAll('[data-open-member-profile]').forEach((button) => {
        button.addEventListener('click', () => {
          openUserProfile(button.dataset.openMemberProfile, { type: 'main', tab: 'users' });
        });
      });
    }

    const picker = $('#group-members-picker');
    const invitesList = $('#group-invites-list');
    const invitesEmpty = $('#group-invites-empty');
    const blockedIds = typeof Credo.getBlockedUserIds === 'function'
      ? Credo.getBlockedUserIds(currentUser.id)
      : new Set();
    const invites = Credo.getGroupInvites().filter((invite) =>
      !blockedIds.has(invite.invitedBy?.id),
    );

    picker.innerHTML = members.length === 0
      ? '<p class="hint">Сначала нужен хотя бы один одобренный участник для приглашения.</p>'
      : members.map((user) => `
          <label class="group-member-option">
            <input type="checkbox" value="${escapeAttr(user.id)}">
            <span>${escapeHtml(user.nickname || '')} · ${escapeHtml(user.fullName || '')}</span>
          </label>
        `).join('');

    if (invites.length === 0) {
      invitesList.innerHTML = '';
      invitesEmpty.classList.remove('hidden');
    } else {
      invitesEmpty.classList.add('hidden');
      invitesList.innerHTML = invites.map((invite) => `
        <div class="card">
          ${Avatar.html({ seed: invite.group?.name || 'Group', chars: 2 })}
          <div class="card-body">
            <div class="card-name">${escapeHtml(invite.group?.name || 'Группа')}</div>
            <div class="card-sub">Пригласил: @${escapeHtml(invite.invitedBy?.nickname || 'unknown')}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn-success btn-small" data-accept-invite="${escapeAttr(invite.id)}">Вступить</button>
            <button class="btn btn-outline btn-small" data-decline-invite="${escapeAttr(invite.id)}">Отклонить</button>
          </div>
        </div>
      `).join('');

      invitesList.querySelectorAll('[data-accept-invite]').forEach((button) => {
        button.addEventListener('click', async () => {
          const result = await API.respondGroupInvite(button.dataset.acceptInvite, 'accept');
          if (!result?.ok) {
            alert('Не удалось принять приглашение: ' + (result.error || 'unknown_error'));
            return;
          }
          refreshAll();
        });
      });

      invitesList.querySelectorAll('[data-decline-invite]').forEach((button) => {
        button.addEventListener('click', async () => {
          const result = await API.respondGroupInvite(button.dataset.declineInvite, 'decline');
          if (!result?.ok) {
            alert('Не удалось отклонить приглашение: ' + (result.error || 'unknown_error'));
            return;
          }
          refreshAll();
        });
      });
    }
  }

  /** HTML-заглушка «ничего не найдено» с экранированным запросом */
  function _searchEmptyHTML(query) {
    return `<div class="search-empty-state">
      <div class="search-empty-icon"></div>
      <p>Ничего не найдено по&nbsp;«${escapeHtml(query)}»</p>
    </div>`;
  }

  // --------------- Вкладка «Профиль» ---------------

  function renderProfileTab(user) {
    _renderProfileContent({
      user,
      avatarId: 'profile-avatar',
      fullNameId: 'profile-fullname',
      infoId: 'profile-info',
      credValueId: 'profile-cred-value',
      credLevelId: 'profile-cred-level',
      credBarId: 'profile-cred-bar',
      cardSelector: '#tab-profile .profile-card',
      historyListId: 'rate-history',
      historyEmptyId: 'rate-history-empty',
    });

    const card = $('#tab-profile .profile-card');
    if (!card) return;

    let actions = $('#profile-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.id = 'profile-actions';
      actions.className = 'user-profile-actions';
      card.appendChild(actions);
    }

    actions.innerHTML = '<button id="profile-settings-btn" class="btn btn-primary btn-small" type="button">Настройки</button>';
    const button = $('#profile-settings-btn');
    if (button) button.addEventListener('click', openSettingsScreen);
  }

  function openSettingsScreen() {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (!currentUser) {
      route();
      return;
    }
    renderSettingsScreen(currentUser);
    showScreen('settings');
  }

  function renderSettingsScreen(user) {
    const avatar = $('#settings-avatar');
    const name = $('#settings-name');
    const meta = $('#settings-meta');
    const toggle = $('#settings-notifications-toggle');
    const blockedList = $('#settings-blocked-list');
    const blockedEmpty = $('#settings-blocked-empty');

    if (avatar) {
      avatar.innerHTML = Avatar.html({
        seed: user.nickname,
        imageUrl: user.avatarUrl || '',
      });
    }
    if (name) name.textContent = user.fullName || '@' + user.nickname;
    if (meta) meta.textContent = `@${user.nickname} · ${user.school} · ${user.grade}`;
    if (toggle) toggle.checked = Credo.getSetting('notificationsEnabled', true) !== false;

    if (!blockedList || !blockedEmpty) return;

    const blocks = (Credo.getUserBlocks ? Credo.getUserBlocks() : [])
      .filter((block) => block.blockerId === user.id);

    if (blocks.length === 0) {
      blockedList.innerHTML = '';
      blockedEmpty.classList.remove('hidden');
      return;
    }

    blockedEmpty.classList.add('hidden');
    blockedList.innerHTML = blocks.map((block) => {
      const blockedUser = block.user || Credo.getUserById(block.blockedId) || {};
      const nickname = blockedUser.nickname || 'unknown';
      const fullName = blockedUser.fullName || '';
      return `
        <div class="card">
          ${Avatar.html({ seed: nickname, imageUrl: blockedUser.avatarUrl || '' })}
          <div class="card-body">
            <div class="card-name">@${escapeHtml(nickname)}</div>
            <div class="card-sub">${escapeHtml(fullName || 'Заблокированный участник')}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn-outline btn-small" type="button" data-settings-unblock="${escapeAttr(block.blockedId)}">Разблокировать</button>
          </div>
        </div>
      `;
    }).join('');

    blockedList.querySelectorAll('[data-settings-unblock]').forEach((button) => {
      button.addEventListener('click', async () => {
        const result = typeof API !== 'undefined' && typeof API.unblockUser === 'function'
          ? await API.unblockUser(button.dataset.settingsUnblock)
          : Credo.unblockUserLocal(user.id, button.dataset.settingsUnblock);
        if (!result?.ok) {
          alert(_safetyErrorMessage(result?.error));
          return;
        }
        renderSettingsScreen(Credo.getUserById(user.id) || user);
      });
    });
  }

  function _renderProfileContent({
    user,
    avatarId = '',
    fullNameId,
    infoId,
    credValueId,
    credLevelId,
    credBarId,
    cardSelector,
    historyListId,
    historyEmptyId,
  }) {
    const level = Credo.getCredLevel(user.cred);
    const progress = Credo.getCredProgress(user.cred);

    if (avatarId) {
      const avatarBox = $('#' + avatarId);
      if (avatarBox) {
        avatarBox.innerHTML = Avatar.html({
          seed: user.nickname,
          imageUrl: user.avatarUrl || '',
        });
      }
    }

    $('#' + fullNameId).textContent = user.fullName;
    $('#' + infoId).textContent = `@${user.nickname} · ${user.school} · ${user.grade}`;

    const credValueEl = $('#' + credValueId);
    credValueEl.textContent = user.cred;
    credValueEl.className = `cred-big-value ${level.css}`;

    const credLabelEl = $('#' + credLevelId);
    credLabelEl.textContent = level.name;
    credLabelEl.className = `cred-level-label ${level.css}`;

    const profileCard = document.querySelector(cardSelector);
    if (profileCard) profileCard.className = `profile-card ${level.css}`;

    const bar = $('#' + credBarId);
    bar.style.width = (progress * 100) + '%';
    bar.className = 'cred-bar ' + level.css;

    _renderRateHistory(user.id, $('#' + historyListId), $('#' + historyEmptyId));
  }

  function _renderRateHistory(userId, histContainer, histEmpty) {
    const history = Credo.getRateHistory(userId);

    if (history.length === 0) {
      histContainer.innerHTML = '';
      histEmpty.classList.remove('hidden');
      return;
    }

    histEmpty.classList.add('hidden');
    histContainer.innerHTML = history.map((r) => {
      const fromUser = Credo.getUserById(r.from);
      const fromName = fromUser ? fromUser.nickname : '???';
      const cls = r.effectiveDelta > 0 ? 'positive'
        : r.effectiveDelta < 0 ? 'negative' : 'neutral';
      const sign = r.effectiveDelta > 0 ? '+' : '';
      const dateStr = formatDate(r.date);
      const stars = '\u2605'.repeat(r.score) + '\u2606'.repeat(5 - r.score);

      return `
        <div class="history-card">
          <div>
            <div style="font-size:13px"><strong>@${escapeHtml(fromName)}</strong></div>
            <div class="history-meta">${escapeHtml(stars)} · ${escapeHtml(dateStr)}</div>
          </div>
          <div class="history-score ${escapeAttr(cls)}">${escapeHtml(sign + String(r.effectiveDelta))}</div>
        </div>`;
    }).join('');
  }

  async function renderAdminTab() {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (!currentUser || !_isAdmin(currentUser)) return;

    const requestId = ++_adminStatsRequest;
    const summary = $('#admin-summary');
    const charts = $('#admin-charts');
    const schoolsList = $('#admin-schools-list');
    const schoolsEmpty = $('#admin-schools-empty');
    const usersList = $('#admin-users-list');
    const usersEmpty = $('#admin-users-empty');
    const groupsList = $('#admin-groups-list');
    const groupsEmpty = $('#admin-groups-empty');
    const reportsList = $('#admin-reports-list');
    const reportsEmpty = $('#admin-reports-empty');

    if (summary) {
      summary.innerHTML = `
        <div class="admin-stat-card"><strong>...</strong><span>\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u0434\u0430\u043d\u043d\u044b\u0445</span></div>
        <div class="admin-stat-card"><strong>...</strong><span>\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0438</span></div>
        <div class="admin-stat-card"><strong>...</strong><span>\u0417\u0430\u044f\u0432\u043a\u0438</span></div>
        <div class="admin-stat-card"><strong>...</strong><span>\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f</span></div>
      `;
    }
    if (charts) {
      charts.innerHTML = `
        <div class="admin-chart-card"><div class="search-empty-state">\u0421\u0442\u0440\u043e\u0438\u043c \u0433\u0440\u0430\u0444\u0438\u043a\u0438...</div></div>
        <div class="admin-chart-card"><div class="search-empty-state">\u041f\u043e\u0434\u0442\u044f\u0433\u0438\u0432\u0430\u0435\u043c \u0430\u043a\u0442\u0438\u0432\u043d\u043e\u0441\u0442\u044c...</div></div>
      `;
    }
    if (reportsList) {
      reportsList.innerHTML = '<div class="search-empty-state">Загружаем жалобы...</div>';
      if (reportsEmpty) reportsEmpty.classList.add('hidden');
    }

    const result = typeof API !== 'undefined' && typeof API.adminStats === 'function'
      ? await API.adminStats()
      : { ok: false, error: 'admin_stats_unavailable' };

    if (requestId !== _adminStatsRequest) return;

    if (!result?.ok) {
      if (summary) {
        summary.innerHTML = '<div class="search-empty-state">\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0430\u0434\u043c\u0438\u043d-\u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0443.</div>';
      }
      if (charts) charts.innerHTML = '';
      if (schoolsList) schoolsList.innerHTML = '';
      if (usersList) usersList.innerHTML = '';
      if (groupsList) groupsList.innerHTML = '';
      if (reportsList) reportsList.innerHTML = '';
      if (schoolsEmpty) schoolsEmpty.classList.remove('hidden');
      if (usersEmpty) usersEmpty.classList.remove('hidden');
      if (groupsEmpty) groupsEmpty.classList.remove('hidden');
      if (reportsEmpty) reportsEmpty.classList.remove('hidden');
      return;
    }

    const stats = result.summary || {};
    if (summary) {
      summary.innerHTML = [
        ['\u0412\u0441\u0435\u0433\u043e \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u0439', stats.totalUsers ?? 0],
        ['\u041d\u043e\u0432\u044b\u0435 \u0437\u0430 24 \u0447\u0430\u0441\u0430', stats.newUsers24h ?? 0],
        ['\u041d\u043e\u0432\u044b\u0435 \u0437\u0430 7 \u0434\u043d\u0435\u0439', stats.newUsers7d ?? 0],
        ['\u0417\u0430\u044f\u0432\u043a\u0438 \u043d\u0430 \u043e\u0434\u043e\u0431\u0440\u0435\u043d\u0438\u0435', stats.pendingUsers ?? 0],
        ['\u041d\u043e\u0432\u044b\u0445 \u0437\u0430\u044f\u0432\u043e\u043a \u0437\u0430 24 \u0447\u0430\u0441\u0430', stats.newApplications24h ?? 0],
        ['\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0439 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e', stats.totalMessages ?? 0],
        ['\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0439 \u0437\u0430 24 \u0447\u0430\u0441\u0430', stats.messages24h ?? 0],
        ['\u0424\u043e\u0442\u043e \u0437\u0430 24 \u0447\u0430\u0441\u0430', stats.images24h ?? 0],
        ['\u0412\u0441\u0435\u0433\u043e \u0433\u0440\u0443\u043f\u043f', stats.totalGroups ?? 0],
        ['\u0418\u043d\u0432\u0430\u0439\u0442\u044b', stats.pendingInvites ?? 0],
        ['Открытые жалобы', stats.openReports ?? 0],
        ['Жалобы за 24 часа', stats.reports24h ?? 0],
        ['Блокировки', stats.totalBlocks ?? 0],
      ].map(([label, value]) => `
        <div class="admin-stat-card">
          <strong>${escapeHtml(String(value))}</strong>
          <span>${escapeHtml(String(label))}</span>
        </div>
      `).join('');
    }

    if (charts) {
      const chartData = result.charts || {};
      charts.innerHTML = [
        _renderAdminBarChart({
          title: '\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438 \u0437\u0430 7 \u0434\u043d\u0435\u0439',
          subtitle: '\u0421\u043a\u043e\u043b\u044c\u043a\u043e \u043d\u043e\u0432\u044b\u0445 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u043e\u0432 \u0441\u043e\u0437\u0434\u0430\u0432\u0430\u043b\u043e\u0441\u044c \u043a\u0430\u0436\u0434\u044b\u0439 \u0434\u0435\u043d\u044c.',
          items: chartData.registrationsByDay || [],
        }),
        _renderAdminBarChart({
          title: '\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f \u0437\u0430 7 \u0434\u043d\u0435\u0439',
          subtitle: '\u0414\u0438\u043d\u0430\u043c\u0438\u043a\u0430 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043d\u044b\u0445 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0439 \u043f\u043e \u0432\u0441\u0435\u043c\u0443 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u044e.',
          items: chartData.messagesByDay || [],
        }),
        _renderAdminRankChart({
          title: '\u0422\u043e\u043f \u0448\u043a\u043e\u043b',
          subtitle: '\u0413\u0434\u0435 \u0441\u0435\u0439\u0447\u0430\u0441 \u0431\u043e\u043b\u044c\u0448\u0435 \u0432\u0441\u0435\u0433\u043e \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u043e\u0432.',
          items: chartData.topSchoolsByUsers || [],
        }),
      ].join('');
    }

    const schools = Array.isArray(result.schools) ? result.schools : [];
    if (schools.length === 0) {
      schoolsList.innerHTML = '';
      schoolsEmpty.classList.remove('hidden');
    } else {
      schoolsEmpty.classList.add('hidden');
      schoolsList.innerHTML = schools.map((school) => `
        <div class="card">
          ${Avatar.html({ seed: school.school, chars: 2 })}
          <div class="card-body">
            <div class="card-name">${escapeHtml(school.school || '')}</div>
            <div class="card-sub">\u0412\u0441\u0435\u0433\u043e: ${escapeHtml(String(school.totalUsers ?? 0))} - \u041e\u0434\u043e\u0431\u0440\u0435\u043d\u043e: ${escapeHtml(String(school.approvedUsers ?? 0))} - \u041e\u0436\u0438\u0434\u0430\u044e\u0442: ${escapeHtml(String(school.pendingUsers ?? 0))}</div>
          </div>
        </div>
      `).join('');
    }

    const recentUsers = Array.isArray(result.recentUsers) ? result.recentUsers : [];
    if (recentUsers.length === 0) {
      usersList.innerHTML = '';
      usersEmpty.classList.remove('hidden');
    } else {
      usersEmpty.classList.add('hidden');
      usersList.innerHTML = recentUsers.map((user) => `
        <div class="card">
          ${Avatar.html({ seed: user.nickname, imageUrl: user.avatarUrl || '' })}
          <div class="card-body">
            <div class="card-name">${escapeHtml(user.nickname || '')}
              <span class="level-badge ${escapeAttr(user.role === 'admin' ? 'trusted' : 'known')}">${escapeHtml(user.role === 'admin' ? 'Admin' : String(user.status || ''))}</span>
            </div>
            <div class="card-sub">${escapeHtml(user.fullName || '')} - ${escapeHtml(user.school || '')} - ${escapeHtml(formatDate(user.createdAt))}</div>
          </div>
        </div>
      `).join('');
    }

    const groups = Array.isArray(result.groups) ? result.groups : [];
    if (groups.length === 0) {
      groupsList.innerHTML = '';
      groupsEmpty.classList.remove('hidden');
    } else {
      groupsEmpty.classList.add('hidden');
      groupsList.innerHTML = groups.map((group) => `
        <div class="card">
          ${Avatar.html({ seed: group.name, imageUrl: group.avatarUrl || '', chars: 2 })}
          <div class="card-body">
            <div class="card-name">${escapeHtml(group.name || '')}
              <span class="level-badge ${escapeAttr(group.type === 'school_public' ? 'known' : 'trusted')}">${escapeHtml(group.type === 'school_public' ? 'School' : 'Private')}</span>
            </div>
            <div class="card-sub">${escapeHtml(group.school || '')} - \u0423\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u0438: ${escapeHtml(String(group.memberCount ?? 0))} - \u0410\u0434\u043c\u0438\u043d\u044b: ${escapeHtml(String(group.adminCount ?? 0))} - \u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f: ${escapeHtml(String(group.messageCount ?? 0))} - \u0424\u043e\u0442\u043e: ${escapeHtml(String(group.imageCount ?? 0))}</div>
          </div>
        </div>
      `).join('');
    }

    await _renderAdminReports(requestId);
  }

  async function _renderAdminReports(requestId) {
    const reportsList = $('#admin-reports-list');
    const reportsEmpty = $('#admin-reports-empty');
    if (!reportsList || !reportsEmpty) return;

    const result = typeof API !== 'undefined' && typeof API.listReports === 'function'
      ? await API.listReports('open')
      : { ok: false, error: 'reports_unavailable' };

    if (requestId !== _adminStatsRequest) return;

    if (!result?.ok) {
      reportsList.innerHTML = '';
      reportsEmpty.textContent = 'Не удалось загрузить жалобы.';
      reportsEmpty.classList.remove('hidden');
      return;
    }

    const reports = Array.isArray(result.reports) ? result.reports : [];
    if (reports.length === 0) {
      reportsList.innerHTML = '';
      reportsEmpty.textContent = 'Открытых жалоб пока нет.';
      reportsEmpty.classList.remove('hidden');
      return;
    }

    reportsEmpty.classList.add('hidden');
    reportsList.innerHTML = reports.map((report) => {
      const reporter = report.reporter || Credo.getUserById(report.reporterId) || {};
      const target = report.target || Credo.getUserById(report.targetId) || {};
      const reason = REPORT_REASON_LABELS[report.reason] || report.reason || 'other';
      return `
        <div class="card admin-report-card">
          ${Avatar.html({ seed: target.nickname || report.targetId || 'target', imageUrl: target.avatarUrl || '' })}
          <div class="card-body">
            <div class="card-name">
              @${escapeHtml(target.nickname || 'unknown')}
              <span class="level-badge known">${escapeHtml(reason)}</span>
            </div>
            <div class="card-sub">Жалоба от @${escapeHtml(reporter.nickname || 'unknown')} · ${escapeHtml(formatDate(report.createdAt))}</div>
            ${report.details ? `<div class="admin-report-details">${escapeHtml(report.details)}</div>` : ''}
          </div>
          <div class="card-actions">
            <button class="btn btn-outline btn-small" type="button" data-report-action="dismiss" data-report-id="${escapeAttr(report.id)}">Закрыть</button>
            <button class="btn btn-danger btn-small" type="button" data-report-action="action" data-report-id="${escapeAttr(report.id)}">Принять меры</button>
          </div>
        </div>
      `;
    }).join('');

    reportsList.querySelectorAll('[data-report-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const result = await API.reviewReport(button.dataset.reportId, button.dataset.reportAction);
        if (!result?.ok) {
          alert(_safetyErrorMessage(result?.error));
          return;
        }
        _renderAdminReports(++_adminStatsRequest).catch(() => {});
      });
    });
  }

  function _renderAdminBarChart({ title, subtitle, items }) {
    const normalized = Array.isArray(items) ? items : [];
    if (!normalized.length) {
      return `
        <div class="admin-chart-card">
          <div class="admin-chart-copy">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <div class="search-empty-state">\u0414\u0430\u043d\u043d\u044b\u0445 \u0434\u043b\u044f \u0433\u0440\u0430\u0444\u0438\u043a\u0430 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.</div>
        </div>
      `;
    }

    const max = normalized.reduce((value, item) => Math.max(value, Number(item.count || item.value || 0)), 0);
    return `
      <div class="admin-chart-card">
        <div class="admin-chart-copy">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(subtitle)}</span>
        </div>
        <div class="admin-chart-bars">
          ${normalized.map((item) => {
            const value = Number(item.count || item.value || 0);
            const height = max > 0 ? Math.max(10, Math.round((value / max) * 100)) : 10;
            return `
              <div class="admin-chart-bar">
                <div class="admin-chart-bar-track">
                  <span class="admin-chart-bar-fill" style="height:${escapeAttr(height)}%"></span>
                </div>
                <strong>${escapeHtml(String(value))}</strong>
                <span>${escapeHtml(String(item.label || ''))}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function _renderAdminRankChart({ title, subtitle, items }) {
    const normalized = Array.isArray(items) ? items : [];
    if (!normalized.length) {
      return `
        <div class="admin-chart-card">
          <div class="admin-chart-copy">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <div class="search-empty-state">\u0414\u0430\u043d\u043d\u044b\u0445 \u0434\u043b\u044f \u0433\u0440\u0430\u0444\u0438\u043a\u0430 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.</div>
        </div>
      `;
    }

    const max = normalized.reduce((value, item) => Math.max(value, Number(item.value || 0)), 0);
    return `
      <div class="admin-chart-card">
        <div class="admin-chart-copy">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(subtitle)}</span>
        </div>
        <div class="admin-rank-list">
          ${normalized.map((item) => {
            const value = Number(item.value || 0);
            const width = max > 0 ? Math.max(8, Math.round((value / max) * 100)) : 8;
            const meta = item.pendingUsers ? ' - \u0437\u0430\u044f\u0432\u043e\u043a ' + item.pendingUsers : '';
            return `
              <div class="admin-rank-item">
                <div class="admin-rank-head">
                  <strong>${escapeHtml(String(item.label || ''))}</strong>
                  <span>${escapeHtml(String(value) + ' \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u043e\u0432' + meta)}</span>
                </div>
                <div class="admin-rank-track">
                  <div class="admin-rank-fill" style="width:${escapeAttr(width)}%"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function _getGroupMemberIdentity(groupId, userId) {
    const group = Credo.getGroupById(groupId);
    if (!group || !Array.isArray(group.members)) return null;
    return group.members.find((member) => member.id === userId) || null;
  }

  function openSafetyModal(userId, mode = 'report') {
    const target = Credo.getUserById(userId);
    if (!target) return;

    _safetyTargetUserId = userId;
    _safetyMode = mode;

    const modal = $('#safety-modal');
    const title = $('#safety-modal-title');
    const copy = $('#safety-modal-copy');
    const form = $('#safety-report-form');
    const primary = $('#safety-modal-primary');
    const targetName = $('#safety-modal-target');
    const details = $('#safety-report-details');
    const reason = $('#safety-report-reason');

    if (!modal || !title || !copy || !form || !primary || !targetName) return;

    targetName.textContent = '@' + target.nickname;
    if (details) details.value = '';
    if (reason) reason.value = 'spam';

    if (mode === 'report') {
      title.textContent = 'Пожаловаться на участника';
      copy.textContent = 'Жалоба попадет администраторам. Укажите причину и короткий комментарий, если нужно.';
      primary.textContent = 'Отправить жалобу';
      primary.className = 'btn btn-danger';
      form.classList.remove('hidden');
    } else {
      const isUnblock = mode === 'unblock';
      title.textContent = isUnblock ? 'Разблокировать участника' : 'Заблокировать участника';
      copy.textContent = isUnblock
        ? 'После разблокировки участник снова появится в списках и личные сообщения будут доступны.'
        : 'Участник исчезнет из личных списков, а прямые сообщения и оценки между вами будут недоступны.';
      primary.textContent = isUnblock ? 'Разблокировать' : 'Заблокировать';
      primary.className = isUnblock ? 'btn btn-primary' : 'btn btn-danger';
      form.classList.add('hidden');
    }

    modal.classList.remove('hidden');
    primary.focus();
  }

  function closeSafetyModal() {
    const modal = $('#safety-modal');
    if (modal) modal.classList.add('hidden');
    _safetyTargetUserId = null;
    _safetyMode = 'report';
  }

  async function handleSafetyPrimary() {
    const targetId = _safetyTargetUserId;
    if (!targetId) return;
    const completedMode = _safetyMode;

    const primary = $('#safety-modal-primary');
    if (primary) primary.disabled = true;

    let result;
    if (_safetyMode === 'report') {
      const reason = $('#safety-report-reason')?.value || 'spam';
      const details = $('#safety-report-details')?.value || '';
      result = typeof API !== 'undefined' && typeof API.reportUser === 'function'
        ? await API.reportUser(targetId, reason, details)
        : { ok: false, error: 'report_unavailable' };
    } else if (_safetyMode === 'unblock') {
      result = typeof API !== 'undefined' && typeof API.unblockUser === 'function'
        ? await API.unblockUser(targetId)
        : Credo.unblockUserLocal(Credo.getCurrentUserId(), targetId);
    } else {
      result = typeof API !== 'undefined' && typeof API.blockUser === 'function'
        ? await API.blockUser(targetId)
        : Credo.blockUserLocal(Credo.getCurrentUserId(), targetId);
    }

    if (primary) primary.disabled = false;

    if (!result?.ok) {
      alert(_safetyErrorMessage(result?.error));
      return;
    }

    closeSafetyModal();
    if (completedMode === 'report') {
      alert('Жалоба отправлена.');
    }

    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (_currentScreen === 'userProfile' && currentProfileUser) {
      openUserProfile(currentProfileUser, _profileReturnState);
      return;
    }
    if (completedMode === 'block' && _currentScreen === 'chat') {
      currentChatPartner = null;
      refreshAll();
      return;
    }
    if (_currentScreen === 'chat' && currentChatPartner) {
      openChat(currentChatPartner);
      return;
    }
    if (_currentScreen === 'settings' && currentUser) {
      renderSettingsScreen(currentUser);
      return;
    }
    if (currentUser) {
      renderMainScreen(currentUser);
      showTab(_activeTab);
    }
  }

  function renderUserProfileActions(actions, user, viewer) {
    if (!actions) return;

    if (user.id === viewer.id) {
      actions.innerHTML = `
        <button class="btn btn-outline btn-small" type="button" data-open-own-profile>Мой профиль</button>
        <button class="btn btn-primary btn-small" type="button" data-open-settings>Настройки</button>
      `;

      const ownProfileBtn = actions.querySelector('[data-open-own-profile]');
      if (ownProfileBtn) {
        ownProfileBtn.addEventListener('click', () => {
          showScreen('main');
          const me = Credo.getUserById(Credo.getCurrentUserId());
          if (me) renderMainScreen(me);
          showTab('profile');
        });
      }

      const settingsBtn = actions.querySelector('[data-open-settings]');
      if (settingsBtn) settingsBtn.addEventListener('click', openSettingsScreen);
      return;
    }

    const isBlocked = _isBlockedPeer(user.id);
    actions.innerHTML = `
      <button class="btn btn-primary btn-small" type="button" data-open-profile-chat="${escapeAttr(user.id)}"${isBlocked ? ' disabled' : ''}>${isBlocked ? 'Заблокировано' : 'Написать'}</button>
      <button class="btn btn-outline btn-small" type="button" data-report-profile-user="${escapeAttr(user.id)}">Пожаловаться</button>
      <button class="btn ${isBlocked ? 'btn-outline' : 'btn-danger'} btn-small" type="button" data-toggle-profile-block="${escapeAttr(user.id)}" data-block-mode="${isBlocked ? 'unblock' : 'block'}">${isBlocked ? 'Разблокировать' : 'Заблокировать'}</button>
    `;

    const chatBtn = actions.querySelector('[data-open-profile-chat]');
    if (chatBtn) chatBtn.addEventListener('click', () => openChat(chatBtn.dataset.openProfileChat));

    const reportBtn = actions.querySelector('[data-report-profile-user]');
    if (reportBtn) reportBtn.addEventListener('click', () => openSafetyModal(reportBtn.dataset.reportProfileUser, 'report'));

    const blockBtn = actions.querySelector('[data-toggle-profile-block]');
    if (blockBtn) {
      blockBtn.addEventListener('click', () => openSafetyModal(blockBtn.dataset.toggleProfileBlock, blockBtn.dataset.blockMode));
    }
  }

  function openUserProfile(userId, returnState = null) {
    const viewer = Credo.getUserById(Credo.getCurrentUserId());
    const user = Credo.getUserById(userId);
    if (!viewer || !user) return;

    currentProfileUser = userId;
    _profileReturnState = returnState;

    _renderProfileContent({
      user,
      avatarId: 'user-profile-avatar',
      fullNameId: 'user-profile-fullname',
      infoId: 'user-profile-info',
      credValueId: 'user-profile-cred-value',
      credLevelId: 'user-profile-cred-level',
      credBarId: 'user-profile-cred-bar',
      cardSelector: '#user-profile-card',
      historyListId: 'user-rate-history',
      historyEmptyId: 'user-rate-history-empty',
    });

    const actions = $('#user-profile-actions');
    if (actions) {
      if (user.id === viewer.id) {
        actions.innerHTML = '<button class="btn btn-outline btn-small" type="button" data-open-own-profile>Мой профиль</button>';
        const ownProfileBtn = actions.querySelector('[data-open-own-profile]');
        if (ownProfileBtn) {
          ownProfileBtn.addEventListener('click', () => {
            showScreen('main');
            const me = Credo.getUserById(Credo.getCurrentUserId());
            if (me) renderMainScreen(me);
            showTab('profile');
          });
        }
      } else {
        actions.innerHTML = `<button class="btn btn-primary btn-small" type="button" data-open-profile-chat="${escapeAttr(user.id)}">Написать</button>`;
        const chatBtn = actions.querySelector('[data-open-profile-chat]');
        if (chatBtn) {
          chatBtn.addEventListener('click', () => openChat(chatBtn.dataset.openProfileChat));
        }
      }
    }

    renderUserProfileActions(actions, user, viewer);
    showScreen('userProfile');
  }

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

  function openChat(partnerId) {
    currentChatGroup = null;
    _clearPendingChatImage();
    currentChatPartner = partnerId;
    const me = Credo.getUserById(Credo.getCurrentUserId());
    const partner = Credo.getUserById(partnerId);
    if (!me || !partner) return;
    if (_isBlockedPeer(partnerId)) {
      alert('Личный чат недоступен из-за блокировки.');
      currentChatPartner = null;
      refreshAll();
      return;
    }

    const level = Credo.getCredLevel(partner.cred);

    $('#chat-partner-avatar').innerHTML = Avatar.html({
      seed: partner.nickname,
      imageUrl: partner.avatarUrl || '',
    });
    $('#chat-partner-name').textContent = `@${partner.nickname}`;
    const profileBtn = $('#chat-partner-profile-btn');
    if (profileBtn) {
      profileBtn.disabled = false;
      profileBtn.onclick = () => openUserProfile(partner.id, { type: 'chat' });
    }
    const reportBtn = $('#chat-partner-report-btn');
    if (reportBtn) {
      reportBtn.classList.remove('hidden');
      reportBtn.onclick = () => openSafetyModal(partner.id, 'report');
    }
    const blockBtn = $('#chat-partner-block-btn');
    if (blockBtn) {
      blockBtn.classList.remove('hidden');
      blockBtn.textContent = 'Заблокировать';
      blockBtn.onclick = () => openSafetyModal(partner.id, 'block');
    }

    // Цветовая индикация уровня партнёра в шапке чата
    const credEl = $('#chat-partner-cred');
    credEl.textContent = `${level.name} · Кредо ${partner.cred}`;
    credEl.className   = `chat-header-cred ${level.css}`;

    // Сбросить статус-строку и запустить наблюдение за партнёром
    _resetChatStatus();
    if (typeof Presence !== 'undefined') {
      Presence.watchPartner(partnerId, me.id, _updateChatStatus);
    }

    // Пометить чат прочитанным → обнулить unread-badge
    if (typeof Notif !== 'undefined') {
      Notif.markChatRead(me.id, partnerId);
      _updateNavBadges(me);
    }

    renderChatMessages(me.id);
    showScreen('chat');

    if (_isBackendMode() && typeof API.syncNow === 'function') {
      API.syncNow().catch(() => {});
    }
  }

  function openGroupChat(groupId) {
    currentChatPartner = null;
    currentChatGroup = groupId;
    _clearPendingChatImage();
    const me = Credo.getUserById(Credo.getCurrentUserId());
    const group = Credo.getGroupById(groupId);
    if (!me || !group) return;

    $('#chat-partner-avatar').innerHTML = Avatar.html({
      seed: group.name,
      imageUrl: group.avatarUrl || '',
      chars: 2,
    });
    $('#chat-partner-name').textContent = group.name;
    const profileBtn = $('#chat-partner-profile-btn');
    if (profileBtn) {
      profileBtn.disabled = true;
      profileBtn.onclick = null;
    }
    const reportBtn = $('#chat-partner-report-btn');
    if (reportBtn) {
      reportBtn.classList.add('hidden');
      reportBtn.onclick = null;
    }
    const blockBtn = $('#chat-partner-block-btn');
    if (blockBtn) {
      blockBtn.classList.add('hidden');
      blockBtn.onclick = null;
    }

    const credEl = $('#chat-partner-cred');
    credEl.textContent = group.type === 'school_public'
      ? `${group.school} · Публичная группа`
      : `${group.memberCount || (group.members || []).length} участников · Закрытая группа`;
    credEl.className = `chat-header-cred ${group.type === 'school_public' ? 'known' : 'trusted'}`;

    _resetChatStatus();
    if (typeof Presence !== 'undefined') {
      Presence.stopWatching();
    }
    renderChatMessages(me.id);
    showScreen('chat');

    if (_isBackendMode() && typeof API.syncNow === 'function') {
      API.syncNow().catch(() => {});
    }
  }

  /** Сбросить строку статуса в шапке чата. */
  function _resetChatStatus() {
    const el = $('#chat-header-status');
    if (el) { el.textContent = ''; el.className = 'chat-header-status'; }
  }

  /**
   * Обновить строку статуса в шапке чата.
   * «Печатает…» имеет приоритет над онлайн/last seen.
   * @param {{ online: boolean, typing: boolean, lastSeen: Date|null }} state
   */
  function _updateChatStatus({ online, typing, lastSeen }) {
    const el = $('#chat-header-status');
    if (!el) return;

    if (typing) {
      el.textContent = 'печатает…';
      el.className   = 'chat-header-status typing';
    } else if (online) {
      el.textContent = 'онлайн';
      el.className   = 'chat-header-status online';
    } else {
      const text = typeof Presence !== 'undefined' ? Presence.formatLastSeen(lastSeen) : '';
      el.textContent = text;
      el.className   = 'chat-header-status lastseen';
    }
  }

  function renderChatMessages(myId) {
    const msgs = _getCurrentChatMessages(myId);
    const container = $('#chat-messages');

    if (msgs.length === 0) {
      container.innerHTML = '<p class="hint">Напишите первое сообщение!</p>';
      return;
    }

    // История рендерится без анимации — .msg-new не добавляется
    container.innerHTML = msgs.map(m => {
      const isMine = m.from === myId;
      const timeStr = formatTime(m.time);
      const sender = m.groupId
        ? (Credo.getUserById(m.from)
          || (isMine ? Credo.getUserById(myId) : null)
          || _getGroupMemberIdentity(m.groupId, m.from))
        : null;
      const showSender = Boolean(sender);
      return `
        <div class="msg ${escapeAttr(isMine ? 'sent' : 'received')}">
          ${showSender ? `
            <div class="msg-author">
              <button class="msg-author-avatar-btn" type="button" data-open-user-profile="${escapeAttr(sender.id)}" title="Открыть профиль">
                ${Avatar.html({ seed: sender.nickname, imageUrl: sender.avatarUrl || '', extraClass: 'msg-author-avatar' })}
              </button>
              <button class="msg-author-name-btn" type="button" data-open-user-profile="${escapeAttr(sender.id)}" title="Открыть профиль">
                <span class="msg-author-name">@${escapeHtml(sender.nickname || '')}</span>
              </button>
            </div>` : ''}
          ${m.attachmentUrl ? `<a class="msg-image-link" href="${escapeAttr(m.attachmentUrl)}" target="_blank" rel="noopener noreferrer"><img class="msg-image" src="${escapeAttr(m.attachmentUrl)}" alt="attachment"></a>` : ''}
          ${m.text ? `<div class="msg-text">${escapeHtml(m.text)}</div>` : ''}
          <div class="msg-footer">
            <div class="msg-actions"><button class="msg-react-btn" aria-label="Реакция" title="Добавить реакцию">+</button></div>
            <div class="msg-time">${escapeHtml(timeStr)}</div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-open-user-profile]').forEach((button) => {
      button.addEventListener('click', () => {
        openUserProfile(button.dataset.openUserProfile, { type: 'chat' });
      });
    });

    container.scrollTop = container.scrollHeight;
  }

  async function handleSendMessage() {
    const input = $('#chat-input');
    const sendButton = $('#chat-send-btn');
    const text = input.value.trim();
    if (!text && !_pendingChatImage) return;
    if (!currentChatPartner && !currentChatGroup) return;

    const myId = Credo.getCurrentUserId();
    const partnerId = currentChatPartner;
    const groupId = currentChatGroup;

    if (partnerId && _isBlockedPeer(partnerId)) {
      alert('Личные сообщения недоступны из-за блокировки.');
      return;
    }

    // Сбросить «печатает» до отправки
    clearTimeout(_typingDebounceTimer);
    if (typeof Presence !== 'undefined' && partnerId) {
      Presence.setTyping(myId, partnerId, false);
    }

    if (sendButton) sendButton.disabled = true;
    input.disabled = true;
    const attachButton = $('#chat-attach-btn');
    if (attachButton) attachButton.disabled = true;

    let result;
    if (typeof API !== 'undefined' && typeof API.sendMessage === 'function') {
      result = await API.sendMessage({
        fromId: myId,
        toId: partnerId,
        groupId,
        text,
        file: _pendingChatImage?.file || null,
        imageWidth: _pendingChatImage?.width || null,
        imageHeight: _pendingChatImage?.height || null,
      });
    } else {
      if (groupId) Credo.sendGroupMessage(groupId, myId, text);
      else Credo.sendMessage(myId, partnerId, text);
      result = { ok: true };
    }

    if (sendButton) sendButton.disabled = false;
    input.disabled = false;
    if (attachButton) attachButton.disabled = false;

    if (!result?.ok) {
      renderChatMessages(myId);
      alert(_safetyErrorMessage(result.error || 'send_failed'));
      return;
    }

    input.value = '';
    _clearPendingChatImage();
    renderChatMessages(myId);
    input.focus();
  }

  async function handleCreateGroup() {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    const name = ($('#group-name')?.value ?? '').trim();
    const selected = [...$$('#group-members-picker input[type="checkbox"]:checked')].map((input) => input.value);

    if (!currentUser) return;
    if (!name) {
      alert('Введите название группы');
      return;
    }

    const result = await API.createGroup(name, selected);
    if (!result?.ok) {
      alert('Не удалось создать группу: ' + (result.error || 'unknown_error'));
      return;
    }

    $('#group-name').value = '';
    $$('#group-members-picker input[type="checkbox"]').forEach((input) => {
      input.checked = false;
    });
    refreshAll();
  }

  async function handleChatImagePick(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const prepared = await _prepareChatImage(file);
    if (!prepared.ok) {
      alert(prepared.error);
      event.target.value = '';
      return;
    }

    _pendingChatImage = prepared;
    _renderPendingChatImage();
    event.target.value = '';
  }

  async function _prepareChatImage(file) {
    const MAX_DIMENSION = 1600;
    const MAX_BYTES = 6 * 1024 * 1024;

    if (!file.type.startsWith('image/')) {
      return { ok: false, error: 'Можно отправлять только изображения.' };
    }

    if (file.type === 'image/gif') {
      if (file.size > MAX_BYTES) {
        return { ok: false, error: 'GIF слишком большой. Сократите файл до 6 МБ.' };
      }
      return { ok: true, file, width: null, height: null, label: file.name, meta: `${Math.round(file.size / 1024)} КБ` };
    }

    try {
      const bitmap = await createImageBitmap(file);
      const ratio = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * ratio));
      const height = Math.max(1, Math.round(bitmap.height * ratio));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/webp', 0.8);
      });

      const finalFile = blob
        ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' })
        : file;

      if (finalFile.size > MAX_BYTES) {
        return { ok: false, error: 'Изображение получилось слишком большим. Попробуйте фото меньшего размера.' };
      }

      return {
        ok: true,
        file: finalFile,
        width,
        height,
        label: finalFile.name,
        meta: `${width}×${height} · ${Math.round(finalFile.size / 1024)} КБ`,
      };
    } catch {
      if (file.size > MAX_BYTES) {
        return { ok: false, error: 'Файл слишком большой. Максимум 6 МБ.' };
      }
      return {
        ok: true,
        file,
        width: null,
        height: null,
        label: file.name,
        meta: `${Math.round(file.size / 1024)} КБ`,
      };
    }
  }

  function _renderPendingChatImage() {
    const box = $('#chat-attachment-preview');
    if (!box) return;

    if (!_pendingChatImage) {
      box.classList.add('hidden');
      return;
    }

    $('#chat-attachment-name').textContent = _pendingChatImage.label;
    $('#chat-attachment-meta').textContent = _pendingChatImage.meta;
    box.classList.remove('hidden');
  }

  function _clearPendingChatImage() {
    _pendingChatImage = null;
    const box = $('#chat-attachment-preview');
    if (box) box.classList.add('hidden');
  }

  // --------------- Экран оценки ---------------

  function openRateScreen() {
    const myId = Credo.getCurrentUserId();
    const toRate = Credo.getUsersToRate(myId);
    pendingRatings = {};

    const container = $('#rate-user-list');

    if (toRate.length === 0) {
      container.innerHTML = '<p class="hint">Нет пользователей для оценки</p>';
      $('#rate-submit-btn').classList.add('hidden');
      showScreen('rate');
      return;
    }

    $('#rate-submit-btn').classList.remove('hidden');

    container.innerHTML = toRate.map(u => {
      const level = Credo.getCredLevel(u.cred);
      return `
        <div class="rate-card" data-rate-user="${escapeAttr(u.id)}">
          ${Avatar.html({ seed: u.nickname, imageUrl: u.avatarUrl || '' })}
          <div class="card-body">
            <div class="card-name">${escapeHtml(u.nickname || '')}
              <span class="level-badge ${escapeAttr(level.css)}">${escapeHtml(level.name)}</span>
            </div>
          </div>
          <div class="star-rating" data-target="${escapeAttr(u.id)}">
            ${[1,2,3,4,5].map(n =>
              `<button class="star" data-star="${escapeAttr(n)}" data-for="${escapeAttr(u.id)}">&#9733;</button>`
            ).join('')}
          </div>
        </div>`;
    }).join('');

    // Обработчики звёзд: клик + hover-подсветка
    container.querySelectorAll('.star').forEach(star => {
      star.addEventListener('click', () => {
        const forId = star.dataset.for;
        const score = parseInt(star.dataset.star);
        pendingRatings[forId] = score;
        highlightStars(forId, score);
      });
      star.addEventListener('mouseenter', () => {
        const forId = star.dataset.for;
        const n = parseInt(star.dataset.star);
        previewStars(forId, n);
      });
      star.addEventListener('mouseleave', () => {
        const forId = star.dataset.for;
        const saved = pendingRatings[forId] || 0;
        highlightStars(forId, saved);
      });
    });

    showScreen('rate');
  }

  function highlightStars(userId, score) {
    const stars = $$(`[data-for="${userId}"]`);
    stars.forEach(s => {
      const n = parseInt(s.dataset.star);
      s.classList.toggle('active', n <= score);
    });
  }

  function previewStars(userId, hoverScore) {
    const stars = $$(`[data-for="${userId}"]`);
    stars.forEach(s => {
      const n = parseInt(s.dataset.star);
      s.classList.toggle('active', n <= hoverScore);
    });
  }

  function submitRatings() {
    const myId = Credo.getCurrentUserId();
    const entries = Object.entries(pendingRatings);

    if (entries.length === 0) {
      alert('Выберите хотя бы одну оценку');
      return;
    }

    let results = [];
    for (const [toId, score] of entries) {
      const res = Credo.rateUser(myId, toId, score);
      results.push(res);
    }

    pendingRatings = {};
    route();
  }

  // --------------- Регистрация (форма) ---------------

  async function handleRegister(e) {
    e.preventDefault();

    const fullName = $('#reg-fullname').value.trim();
    const school   = ($('#reg-school')?.value ?? '').trim();
    const grade    = $('#reg-grade').value.trim();
    const nickname = $('#reg-nickname').value.trim();
    const phone    = ($('#reg-phone')?.value ?? '').trim();

    if (!fullName || !school || !grade || !nickname) return;

    const result = await API.register({
      fullName,
      school,
      grade,
      nickname,
      phone,
    });

    if (!result.ok) {
      const REGISTER_ERRORS = {
        device_blocked:      'Регистрация заблокирована на этом устройстве.',
        nickname_taken:      'Этот никнейм уже занят.',
        phone_taken:         'Этот номер телефона уже зарегистрирован.',
        fullName_taken:      'Пользователь с таким ФИО уже существует.',
        rate_limit_exceeded: 'Слишком много попыток регистрации. Попробуйте позже.',
        fullName_required:   'Введите ФИО.',
        school_required:     'Выберите школу.',
        grade_required:      'Введите класс.',
        nickname_required:   'Введите никнейм.',
      };
      alert(REGISTER_ERRORS[result.error] || ('Ошибка регистрации: ' + (result.error || 'неизвестная ошибка')));
      return;
    }

    // Автоподстановка никнейма в поле логина
    const loginNickInput = $('#login-nickname');
    if (loginNickInput) loginNickInput.value = nickname;

    $('#register-form').reset();
    refreshDemoSelect();

    // If the backend returned a user with a phone pending verification,
    // navigate to the OTP screen instead of calling route().
    if (result.user?.phone && result.user?.phoneVerified === false) {
      _pendingPhone = result.user.phone;
      $('#verify-phone-number').textContent = _pendingPhone;

      const devHint = $('#otp-dev-hint');
      if (result._devOtp) {
        // Dev mode: show OTP on screen for easy testing
        devHint.textContent = `[DEV] Код: ${result._devOtp} (или "000000")`;
        console.info(`[DEV] OTP для верификации телефона: ${result._devOtp}`);
      } else {
        devHint.textContent = '';
      }
      $('#otp-attempts-hint').style.display = 'none';
      $('#otp-code').value = '';
      showScreen('verifyPhone');
      return;
    }

    route();
  }

  // --------------- Подтверждение телефона (OTP) ---------------

  async function handleVerifyPhone() {
    const code = ($('#otp-code')?.value ?? '').trim();
    if (!code) { alert('Введите код из SMS'); return; }
    if (!_pendingPhone) { route(); return; }

    const btn = $('#otp-submit-btn');
    if (btn) btn.disabled = true;

    const result = await API.verifyPhone(_pendingPhone, code);

    if (btn) btn.disabled = false;

    if (!result.ok) {
      const VERIFY_ERRORS = {
        invalid_code:             'Неверный код.',
        too_many_attempts:        'Слишком много попыток. Запросите новый код.',
        otp_not_found_or_expired: 'Код недействителен или истёк. Запросите новый.',
        rate_limit_exceeded:      'Слишком много запросов. Подождите немного.',
      };
      const hint = $('#otp-attempts-hint');
      let msg = VERIFY_ERRORS[result.error] || ('Ошибка: ' + (result.error || 'неизвестная'));
      if (result.error === 'invalid_code' && typeof result.attemptsLeft === 'number') {
        msg += ` Осталось попыток: ${result.attemptsLeft}.`;
      }
      if (hint) { hint.textContent = msg; hint.style.display = 'block'; }
      return;
    }

    // Success — phone is verified; continue with normal routing
    _pendingPhone = '';
    const userId = Credo.getCurrentUserId();
    if (userId) {
      // Sync phoneVerified flag into local cache
      Credo.updateUser(userId, { phoneVerified: true });
    }
    route();
  }

  async function handleResendOtp() {
    if (!_pendingPhone) return;

    const link = $('#otp-resend-link');
    if (link) { link.style.pointerEvents = 'none'; link.textContent = 'Отправляем...'; }

    const result = await API.resendOtp(_pendingPhone);

    if (link) {
      link.style.pointerEvents = '';
      link.textContent = 'Отправить снова';
    }

    if (!result.ok) {
      alert('Не удалось отправить код: ' + (result.error || 'ошибка'));
      return;
    }

    const devHint = $('#otp-dev-hint');
    if (result._devOtp) {
      devHint.textContent = `[DEV] Новый код: ${result._devOtp} (или "000000")`;
      console.info(`[DEV] Resent OTP: ${result._devOtp}`);
    }

    const hint = $('#otp-attempts-hint');
    if (hint) { hint.textContent = 'Новый код отправлен.'; hint.style.display = 'block'; }
    $('#otp-code').value = '';
  }

  // --------------- Установка пароля ---------------

  async function handleSetPassword() {
    const password = $('#setpass-password').value.trim();
    const userId = Credo.getCurrentUserId();

    if (!password) {
      alert('Введите пароль');
      return;
    }

    const spResult = await API.setPassword(userId, password);

    if (!spResult.ok) {
      alert('Ошибка сохранения пароля: ' + (spResult.error || 'неизвестная ошибка'));
      return;
    }
    route();
  }

  // --------------- Логин ---------------

  async function handleLogin() {
    const nickname = $('#login-nickname').value.trim();
    const password = $('#login-password').value.trim();

    if (!nickname || !password) {
      alert('Введите никнейм и пароль');
      return;
    }

    const result = await API.login(nickname, password);

    if (!result.ok) {
      const LOGIN_ERRORS = {
        invalid_credentials:  'Неверный никнейм или пароль.',
        account_not_approved: 'Аккаунт ещё не одобрен другими участниками.',
        account_rejected:     'Аккаунт отклонён. Вход невозможен.',
        phone_not_verified:   'Сначала подтвердите номер телефона.',
        rate_limit_exceeded:  'Слишком много попыток. Подождите немного.',
        password_required:    'Введите пароль.',
        nickname_required:    'Введите никнейм.',
      };
      alert(LOGIN_ERRORS[result.error] || ('Ошибка входа: ' + (result.error || 'неизвестная')));
      return;
    }

    route();
  }

  // --------------- Демо-панель ---------------

  function refreshDemoSelect() {
    const select = $('#demo-user-select');
    const users = _getLocalAccounts();
    const currentId = Credo.getCurrentUserId();
    const currentUser = currentId ? Credo.getUserById(currentId) : null;

    _syncDemoBarMode(currentUser);
    if (!_isAdmin(currentUser)) return;

    select.innerHTML = '<option value="">- Select user -</option>' +
      users.map((u) => {
        const sel = u.id === currentId ? ' selected' : '';
        const status = u.status === 'pending' ? ' (pending)'
                     : u.status === 'rejected' ? ' (rejected)' : '';

        return `<option value="${escapeAttr(u.id)}"${sel}>@${escapeHtml(u.nickname || '')}${escapeHtml(status)}</option>`;
      }).join('');

    _renderDemoMenu(users, currentId);
  }

  async function handleDemoSwitch(forcedId) {
    const currentUser = Credo.getUserById(Credo.getCurrentUserId());
    if (!_isAdmin(currentUser)) return;

    const select = $('#demo-user-select');
    const id = typeof forcedId === 'string' ? forcedId : select.value;
    if (select.value !== id) {
      select.value = id;
    }

    if (_isBackendMode() && typeof API !== 'undefined' && typeof API.switchAccount === 'function') {
      const result = await API.switchAccount(id);
      if (!result?.ok) {
        if (select) select.value = currentUser?.id || '';
        _renderDemoMenu(_getLocalAccounts(), currentUser?.id || '');
        if (result.error === 'login_required') {
          alert('Для этого аккаунта нужно заново войти, чтобы восстановить серверную сессию.');
        } else {
          alert('Не удалось переключить аккаунт: ' + (result.error || 'unknown_error'));
        }
        return;
      }
      _resetUIState();
      route();
      return;
    }

    if (id) {
      Credo.setCurrentUserId(id);
    } else {
      Credo.setCurrentUserId(null);
    }
    _resetUIState();
    route();
  }

  async function handleDemoLogout() {
    if (typeof API !== 'undefined' && typeof API.logout === 'function') {
      await API.logout().catch(() => {});
    } else {
      Credo.setCurrentUserId(null);
    }
    _resetUIState();
    route();
  }

  async function handleDemoReset() {
    if (!confirm('Сбросить ВСЕ данные?')) return;
    if (typeof API !== 'undefined' && typeof API.logout === 'function') {
      await API.logout().catch(() => {});
    }
    Credo.resetAll();
    _resetUIState();
    route();
    refreshDemoSelect();
  }

  /**
   * Сбросить UI-стейт при смене пользователя:
   * поисковые запросы, поля ввода поиска, счётчики уведомлений.
   */
  function _resetUIState() {
    _chatSearchQuery   = '';
    _memberSearchQuery = '';
    _pendingPhone      = '';
    _clearPendingChatImage();
    currentChatPartner = null;
    currentChatGroup = null;
    const searchChats   = $('#search-chats');
    const searchMembers = $('#search-members');
    if (searchChats)   searchChats.value   = '';
    if (searchMembers) searchMembers.value = '';
    if (typeof Notif !== 'undefined') Notif.reset();
    if (typeof Presence !== 'undefined') Presence.stopActivityTracking();
  }

  // --------------- Обновление всего ---------------

  function refreshAll() {
    refreshDemoSelect();
    route();
  }

  function handleServerSync() {
    refreshDemoSelect();

    const userId = Credo.getCurrentUserId();
    if (!userId) return;

    const user = Credo.getUserById(userId);
    if (!user) {
      route();
      return;
    }

    if (user.status !== 'approved' || !user.passwordHash) {
      route();
      return;
    }

    if (_currentScreen === 'chat') {
      if (currentChatPartner) {
        const partner = Credo.getUserById(currentChatPartner);
        if (!partner) {
          currentChatPartner = null;
          route();
          return;
        }

        renderChatMessages(user.id);
        if (typeof Notif !== 'undefined') {
          Notif.markChatRead(user.id, currentChatPartner);
          _updateNavBadges(user);
        }
        return;
      }

      if (currentChatGroup) {
        const group = Credo.getGroupById(currentChatGroup);
        if (!group) {
          currentChatGroup = null;
          route();
          return;
        }

        renderChatMessages(user.id);
        return;
      }
    }

    if (_currentScreen === 'settings') {
      renderSettingsScreen(user);
      return;
    }

    if (_currentScreen === 'userProfile' && currentProfileUser) {
      openUserProfile(currentProfileUser, _profileReturnState);
      return;
    }

    if (_currentScreen === 'main') {
      renderMainScreen(user);
      showTab(_activeTab);
      return;
    }

    route();
  }

  // --------------- Хелперы ---------------

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return escapeHtml(String(text ?? ''))
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
      ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  // --------------- Инициализация ---------------

  function init() {
    setAppVisible(false);

    // Регистрация
    $('#register-form').addEventListener('submit', handleRegister);

    // Подтверждение телефона
    $('#otp-submit-btn').addEventListener('click', handleVerifyPhone);
    $('#otp-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleVerifyPhone();
    });
    $('#otp-resend-link').addEventListener('click', (e) => {
      e.preventDefault();
      handleResendOtp();
    });

    // Создание пароля
    $('#setpass-btn').addEventListener('click', handleSetPassword);

    // Логин
    $('#login-btn').addEventListener('click', handleLogin);

    // Кнопка "Регистрация" на экране логина
    const regLink = $('#login-register-link');
    if (regLink) {
      regLink.addEventListener('click', () => openExperience('register'));
    }
    $$('[data-open-login]').forEach((button) => {
      button.addEventListener('click', () => openExperience('login'));
    });
    $$('[data-open-register]').forEach((button) => {
      button.addEventListener('click', () => openExperience('register'));
    });

    const onboardingNext = $('#onboarding-next-btn');
    if (onboardingNext) onboardingNext.addEventListener('click', handleOnboardingNext);
    const onboardingSkip = $('#onboarding-skip-btn');
    if (onboardingSkip) onboardingSkip.addEventListener('click', completeOnboarding);

    const profileSettingsBtn = $('#profile-settings-btn');
    if (profileSettingsBtn) profileSettingsBtn.addEventListener('click', openSettingsScreen);
    const settingsBackBtn = $('#settings-back-btn');
    if (settingsBackBtn) {
      settingsBackBtn.addEventListener('click', () => {
        const user = Credo.getUserById(Credo.getCurrentUserId());
        showScreen('main');
        if (user) renderMainScreen(user);
        showTab('profile');
      });
    }
    const settingsLogoutBtn = $('#settings-logout-btn');
    if (settingsLogoutBtn) settingsLogoutBtn.addEventListener('click', handleDemoLogout);
    const settingsToggle = $('#settings-notifications-toggle');
    if (settingsToggle) {
      settingsToggle.addEventListener('change', () => {
        Credo.setSetting('notificationsEnabled', settingsToggle.checked);
      });
    }

    const safetyPrimary = $('#safety-modal-primary');
    if (safetyPrimary) safetyPrimary.addEventListener('click', handleSafetyPrimary);
    const safetyCancel = $('#safety-modal-cancel');
    if (safetyCancel) safetyCancel.addEventListener('click', closeSafetyModal);
    const safetyModal = $('#safety-modal');
    if (safetyModal) {
      safetyModal.addEventListener('click', (event) => {
        if (event.target === safetyModal) closeSafetyModal();
      });
    }

    // Навигация по вкладкам
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showTab(btn.dataset.tab);
        if (btn.dataset.tab === 'admin') {
          renderAdminTab().catch(() => {});
        }
      });
    });

    // Поиск по чатам
    $('#search-chats').addEventListener('input', () => {
      _chatSearchQuery = $('#search-chats').value;
      const user = Credo.getUserById(Credo.getCurrentUserId());
      if (user) renderChatList(user);
    });
    $('#search-chats').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('#search-chats').value = '';
        _chatSearchQuery = '';
        const user = Credo.getUserById(Credo.getCurrentUserId());
        if (user) renderChatList(user);
      }
    });

    // Поиск по участникам
    $('#search-members').addEventListener('input', () => {
      _memberSearchQuery = $('#search-members').value;
      const user = Credo.getUserById(Credo.getCurrentUserId());
      if (user) renderUsersTab(user);
    });
    $('#search-members').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('#search-members').value = '';
        _memberSearchQuery = '';
        const user = Credo.getUserById(Credo.getCurrentUserId());
        if (user) renderUsersTab(user);
      }
    });

    // Чат
    $('#chat-back-btn').addEventListener('click', () => {
      // Снять флаг «печатает» перед выходом из чата
      clearTimeout(_typingDebounceTimer);
      if (typeof Presence !== 'undefined' && currentChatPartner) {
        Presence.setTyping(Credo.getCurrentUserId(), currentChatPartner, false);
        Presence.stopWatching();
      }
      currentChatPartner = null;
      currentChatGroup = null;
      _clearPendingChatImage();
      _resetChatStatus();
      refreshAll();
    });
    $('#chat-send-btn').addEventListener('click', handleSendMessage);
    $('#user-profile-back-btn').addEventListener('click', closeUserProfile);
    $('#chat-attach-btn').addEventListener('click', () => $('#chat-image-input').click());
    $('#chat-image-input').addEventListener('change', handleChatImagePick);
    $('#chat-attachment-clear').addEventListener('click', _clearPendingChatImage);
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSendMessage();
    });

    // Индикатор «печатает…» с debounce 400 мс (активируется, гаснет через 2.5 с)
    $('#chat-input').addEventListener('input', () => {
      if (!currentChatPartner || currentChatGroup || typeof Presence === 'undefined') return;
      const myId = Credo.getCurrentUserId();
      if (!myId) return;

      Presence.touchActive(myId);
      Presence.setTyping(myId, currentChatPartner, true);

      clearTimeout(_typingDebounceTimer);
      _typingDebounceTimer = setTimeout(() => {
        Presence.setTyping(myId, currentChatPartner, false);
      }, 2500);
    });

    // Оценка
    $('#rate-notification-btn').addEventListener('click', openRateScreen);
    $('#rate-back-btn').addEventListener('click', () => refreshAll());
    $('#rate-submit-btn').addEventListener('click', submitRatings);
    $('#create-group-btn').addEventListener('click', handleCreateGroup);

    // Демо
    $('#demo-user-select').addEventListener('change', () => handleDemoSwitch());
    $('#app-home-btn').addEventListener('click', closeExperience);
    $('#demo-logout-btn').addEventListener('click', handleDemoLogout);
    $('#demo-reset-btn').addEventListener('click', handleDemoReset);

    const demoTrigger = $('#demo-user-trigger');
    if (demoTrigger) {
      demoTrigger.addEventListener('click', () => {
        const isOpen = demoTrigger.getAttribute('aria-expanded') === 'true';
        _setDemoMenuOpen(!isOpen);
      });
    }

    document.addEventListener('click', (event) => {
      const wrap = $('#demo-bar .demo-select-wrap');
      if (!wrap || wrap.contains(event.target)) return;
      _setDemoMenuOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        _setDemoMenuOpen(false);
        closeSafetyModal();
      }
    });

    if (typeof API !== 'undefined' && API.SYNC_EVENT) {
      window.addEventListener(API.SYNC_EVENT, handleServerSync);
    }

    $$('[data-go-home]').forEach((button) => {
      button.addEventListener('click', closeExperience);
    });

    const openMode = new URLSearchParams(window.location.search).get('open');
    if (openMode === 'dashboard' || openMode === 'register') {
      openExperience('register');
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }

    wireLandingFrame();
    refreshDemoSelect();
  }

  // Запуск при загрузке
  document.addEventListener('DOMContentLoaded', init);

  return { refreshAll, route, openRateScreen, openExperience, openDashboardExperience, closeExperience };

})();
