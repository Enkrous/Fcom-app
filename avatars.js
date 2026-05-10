'use strict';

/**
 * avatars.js — Универсальный рендер аватаров (пользователи и группы).
 *
 * Ключевая возможность: детерминированный цвет фона по строке-сиду.
 * Один и тот же ник/id → всегда один и тот же цвет, без внешних зависимостей.
 *
 * Использование:
 *   // Аватар пользователя (1 буква)
 *   Avatar.html({ seed: user.nickname })
 *
 *   // Аватар группы (2 буквы, например "GC")
 *   Avatar.html({ seed: group.name, chars: 2 })
 *
 *   // Аватар с фото (fallback → инициалы при ошибке загрузки)
 *   Avatar.html({ seed: user.nickname, imageUrl: user.avatarUrl })
 *
 *   // Аватар с кастомным лейблом и доп. классом
 *   Avatar.html({ seed: id, label: '?', extraClass: 'avatar-large' })
 */
const Avatar = (() => {

  // 12 пар градиентов: приглушённые, хорошо читаемые на тёмном фоне,
  // белый текст поверх любого из них выглядит контрастно.
  const PALETTE = [
    ['#4A6FA5', '#2D4A7A'],  // синий
    ['#7B5EA7', '#523D80'],  // фиолетовый
    ['#3D9177', '#2A6B5A'],  // бирюзовый
    ['#9A6B3D', '#7A4D25'],  // янтарный
    ['#5A8FB5', '#3A6A94'],  // стальной синий
    ['#A04F75', '#7A3055'],  // розовый
    ['#4A8F63', '#2E6842'],  // зелёный
    ['#8F4545', '#6A2828'],  // тёмно-красный
    ['#6A8F45', '#4A6828'],  // оливковый
    ['#8A7A3D', '#6A5A25'],  // золотистый
    ['#554A8F', '#362E6A'],  // индиго
    ['#3D7E8F', '#255A6A'],  // морской
  ];

  /**
   * djb2 hash — быстрый, детерминированный, хорошо распределяет строки.
   * Одинаковая строка → одинаковое число на любом устройстве.
   */
  function _hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  /**
   * Возвращает CSS-значение background для данного сида.
   * @param {string} seed
   * @returns {string}  e.g. "linear-gradient(135deg, #4A6FA5, #2D4A7A)"
   */
  function colorFor(seed) {
    const pair = PALETTE[_hash(String(seed || '')) % PALETTE.length];
    return `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`;
  }

  /**
   * Аббревиатура для отображения в аватаре.
   * @param {string} name   — строка (ник, название группы)
   * @param {number} maxLen — 1 для пользователей, 2 для групп
   */
  function initials(name, maxLen) {
    maxLen = maxLen || 1;
    if (!name) return '?';
    const words = String(name).trim().split(/[\s_\-]+/);
    if (maxLen === 1 || words.length === 1) {
      return words[0].charAt(0).toUpperCase();
    }
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }

  // ─── Минимальный HTML/attr escape ────────────────────────────────

  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _escAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  // ─── Основная функция ────────────────────────────────────────────

  /**
   * Генерирует HTML-строку для элемента аватара (.card-avatar).
   *
   * @param {object}  [opts]
   * @param {string}  [opts.seed]        — сид для цвета (nickname, group name, id…)
   * @param {string}  [opts.label]       — явный текст; по умолчанию = initials(seed, chars)
   * @param {string}  [opts.imageUrl]    — URL фото; необязательно
   * @param {number}  [opts.chars]       — макс. кол-во букв (1 — пользователи, 2 — группы)
   * @param {string}  [opts.extraClass]  — доп. CSS-классы для корневого div
   * @returns {string}
   */
  function html(opts) {
    opts = opts || {};
    var seed       = opts.seed       || '';
    var label      = opts.label;
    var imageUrl   = opts.imageUrl   || '';
    var chars      = opts.chars      || 1;
    var extraClass = opts.extraClass || '';

    var bg   = colorFor(seed);
    var text = (label !== undefined && label !== null)
               ? label
               : initials(seed, chars);

    var cls    = extraClass ? 'card-avatar ' + extraClass : 'card-avatar';
    var safeBg = _escAttr(bg);

    if (imageUrl) {
      // Изображение перекрывает fallback-текст через position:absolute.
      // При ошибке загрузки — img скрывается, проявляется span с инициалом.
      return (
        '<div class="' + cls + '" style="background:' + safeBg + '">' +
          '<span class="avatar-fallback">' + _esc(text) + '</span>' +
          '<img class="avatar-photo" src="' + _escAttr(imageUrl) + '" alt=""' +
          ' onerror="this.style.display=\'none\'">' +
        '</div>'
      );
    }

    // Текстовый аватар (инициал / аббревиатура)
    return '<div class="' + cls + '" style="background:' + safeBg + '">' + _esc(text) + '</div>';
  }

  // ─── Public API ──────────────────────────────────────────────────

  return { html, colorFor, initials };

})();
