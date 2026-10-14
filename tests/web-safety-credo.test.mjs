import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const me = { id: 'me', nickname: 'me', fullName: 'Me', school: 'Fiztex', status: 'approved', cred: 15, ratings: [], chats: [] };
const peer = { id: 'peer', nickname: 'peer', fullName: 'Peer', school: 'Fiztex', status: 'approved', cred: 14.5, ratings: [], chats: [] };

function element() {
  const classes = new Set();
  const attributes = new Map();
  return {
    innerHTML: '', textContent: '', value: '', disabled: false,
    classList: {
      add: (...items) => items.forEach((item) => classes.add(item)),
      remove: (...items) => items.forEach((item) => classes.delete(item)),
      toggle(item, enabled) {
        if (enabled === undefined) enabled = !classes.has(item);
        if (enabled) classes.add(item); else classes.delete(item);
      },
      contains: (item) => classes.has(item),
    },
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: (key) => attributes.get(key),
    removeAttribute: (key) => attributes.delete(key),
    addEventListener() {}, focus() {},
    querySelectorAll(selector) {
      if (selector !== '[data-unblock-user]') return [];
      if (!this.buttons) {
        this.buttons = [...this.innerHTML.matchAll(/data-unblock-user="([^"]+)"/g)].map((match) => {
          const button = { dataset: { unblockUser: match[1] }, handlers: {} };
          button.addEventListener = (event, callback) => { button.handlers[event] = callback; };
          return button;
        });
      }
      return this.buttons;
    },
  };
}

function browserFixture({ users = [me, peer], blocks = [], fetchResult } = {}) {
  const data = new Map([
    ['credo_users', JSON.stringify(users)],
    ['credo_current_user', 'me'],
    ['credo_user_blocks', JSON.stringify(blocks)],
  ]);
  const nodes = new Map();
  const readyHandlers = [];
  const events = [];
  const calls = [];
  const document = {
    createElement() {
      const node = { textContent: '' };
      Object.defineProperty(node, 'innerHTML', { get: () => String(node.textContent)
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
      return node;
    },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    querySelectorAll: () => [],
    addEventListener(event, callback) { if (event === 'DOMContentLoaded') readyHandlers.push(callback); },
    body: element(),
  };
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
    },
    document,
    window: { dispatchEvent: (event) => events.push(event), addEventListener() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    console, URL, URLSearchParams, TextEncoder, crypto: globalThis.crypto,
    setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    Avatar: { html: () => '<span class="avatar"></span>' },
    fetch: async (url, options) => {
      const path = new URL(url).pathname.split('/v1')[1];
      const request = { path, ...options };
      calls.push(request);
      return { json: async () => fetchResult?.(request) ?? { ok: false, error: 'fetch_failed' } };
    },
  });
  const load = (filename) => vm.runInContext(readFileSync(new URL('../' + filename, import.meta.url), 'utf8'), context);
  load('credo.js');
  load('api.js');
  // Run API initialization without a stored token, so only the read/write
  // adapters are installed and no unrelated periodic network sync starts.
  readyHandlers[0]();
  const Credo = vm.runInContext('Credo', context);
  const API = vm.runInContext('API', context);
  return {
    context, nodes, data, calls, events, Credo, API,
    loadUi() {
      // Expose existing UI functions only within this isolated test runtime.
      const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(
        'return { refreshAll, route, openRateScreen, openExperience, openDashboardExperience, closeExperience };',
        'return { renderBlockedUsers, openSafetyModal, renderChatMessages, setGroupForTest: (id) => { currentChatGroup = id; } };',
      );
      vm.runInContext(source, context);
      return vm.runInContext('App', context);
    },
  };
}

test('backend eligibility uses server cooldown despite local chats and rating history', () => {
  const fixture = browserFixture({ users: [me, { ...peer, canRateForUserId: 'me', canRate: { ok: false, reason: '24h_limit' } }] });
  fixture.Credo.sendMessage('me', 'peer', 'local conversation');
  assert.equal(fixture.Credo.canRate('me', 'peer').reason, '24h_limit');
  assert.equal(fixture.Credo.getUsersToRate('me').length, 0);
  fixture.Credo.updateUser('peer', { canRate: { ok: true } });
  fixture.data.set('credo_chats', '{}');
  assert.equal(fixture.Credo.getUsersToRate('me').length, 1);
});

test('cached eligibility belongs to the caller who requested it', () => {
  const fixture = browserFixture({ users: [me, { ...peer, canRateForUserId: 'another-account', canRate: { ok: true } }] });
  assert.equal(fixture.Credo.canRate('me', 'peer').reason, 'sync_required');
  assert.equal(fixture.Credo.getUsersToRate('me').length, 0);
});

test('backend rejected ratings leave the local Credo value and history unchanged', async () => {
  const fixture = browserFixture({ fetchResult: () => ({ ok: false, error: '24h_limit' }) });
  const before = fixture.data.get('credo_users');
  const result = await fixture.Credo.rateUser('me', 'peer', 5);
  assert.equal(result.error, '24h_limit');
  assert.equal(fixture.data.get('credo_users'), before);
  assert.equal(fixture.calls.at(-1).path, '/rate');
});

test('successful ratings use exact server Credo metadata and update eligibility', async () => {
  const serverLevel = { name: 'Свой', min: 30, max: null, css: 'own' };
  const entry = { from: 'me', to: 'peer', score: 5, effectiveDelta: 0.56, date: '2026-10-14T10:00:00Z' };
  const fixture = browserFixture({ fetchResult: () => ({ ok: true, entry, newCred: 30.1, credLevel: serverLevel, credProgress: 1 }) });
  const result = await fixture.Credo.rateUser('me', 'peer', 5);
  assert.equal(result.ok, true);
  const user = fixture.Credo.getUserById('peer');
  assert.equal(user.cred, 30.1);
  assert.equal(fixture.Credo.getUserCredLevel(user).css, 'own');
  assert.equal(fixture.Credo.getUserCredProgress(user), 1);
  assert.equal(user.ratings.length, 1);
  assert.equal(fixture.Credo.getUsersToRate('me').length, 0);
});

test('settings exposes outgoing blocks and can unblock a user hidden from the user list', () => {
  const fixture = browserFixture({ users: [me], blocks: [
    { blockerId: 'me', blockedId: 'peer', user: peer },
    { blockerId: 'incoming', blockedId: 'me', user: { ...peer, id: 'incoming' } },
  ] });
  const ui = fixture.loadUi();
  ui.renderBlockedUsers(me);
  const list = fixture.nodes.get('#settings-blocked-list');
  assert.match(list.innerHTML, /Разблокировать/);
  assert.match(list.innerHTML, /data-unblock-user="peer"/);
  assert.doesNotMatch(list.innerHTML, /data-unblock-user="incoming"/);
  const button = list.querySelectorAll('[data-unblock-user]')[0];
  button.handlers.click();
  assert.equal(fixture.nodes.get('#safety-modal-title').textContent, 'Разблокировать участника');
  assert.equal(fixture.nodes.get('#safety-modal-target').textContent, '@peer');
});

test('unblock uses the successful mutation result even when subsequent sync fails', async () => {
  const fixture = browserFixture({ users: [me], blocks: [{ blockerId: 'me', blockedId: 'peer', user: peer }],
    fetchResult: (request) => request.path === '/block-user' && request.method === 'POST'
      ? { ok: true, targetId: 'peer', action: 'unblock', blocks: [] }
      : { ok: false, error: 'fetch_failed' },
  });
  const result = await fixture.API.unblockUser('peer');
  assert.equal(result.ok, true);
  assert.equal(fixture.Credo.getUserBlocks().length, 0);
  assert.equal(JSON.parse(fixture.calls[0].body).action, 'unblock');
});

test('settings can remove a stale block without a target profile', () => {
  const fixture = browserFixture({ users: [me], blocks: [{ blockerId: 'me', blockedId: 'deleted', user: null }] });
  const ui = fixture.loadUi();
  ui.renderBlockedUsers(me);
  const button = fixture.nodes.get('#settings-blocked-list').querySelectorAll('[data-unblock-user]')[0];
  button.handlers.click();
  assert.equal(fixture.nodes.get('#safety-modal-title').textContent, 'Разблокировать участника');
  assert.equal(fixture.nodes.get('#safety-modal-target').textContent, 'Участник');
});

test('forced refresh captures block changes from another device', async () => {
  let blocks = [];
  const fixture = browserFixture({ fetchResult: () => ({ ok: true, blocks }) });
  await fixture.API.refreshBlockedUsers();
  blocks = [{ blockerId: 'me', blockedId: 'peer', user: peer }];
  const result = await fixture.API.refreshBlockedUsers({ force: true });
  assert.equal(result.changed, true);
  assert.equal(fixture.Credo.getUserBlocks().length, 1);
});

test('deleted group authors are labeled and have no profile actions even with stale user cache', () => {
  const fixture = browserFixture();
  fixture.data.set('credo_group_chats', JSON.stringify({ group: [{
    id: 'message', from: 'peer', groupId: 'group', senderDeleted: true,
    text: 'preserved conversation', time: '2026-10-14T10:00:00Z',
  }] }));
  const ui = fixture.loadUi();
  ui.setGroupForTest('group');
  ui.renderChatMessages('me');
  const html = fixture.nodes.get('#chat-messages').innerHTML;
  assert.match(html, /Удалённый пользователь/);
  assert.match(html, /preserved conversation/);
  assert.doesNotMatch(html, /data-open-user-profile/);
});
