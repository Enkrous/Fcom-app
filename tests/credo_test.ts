import assert from 'node:assert/strict';
import {
  canRate,
  getCredLevel,
  getCredProgress,
  loadRatingContext,
  readAllRows,
  withCredo,
} from '../supabase/functions/_shared/credo.ts';

Deno.test('Credo levels handle fractional ratings at every boundary', () => {
  const cases = [
    [-2, 'novice'], [0, 'novice'], [4.99, 'novice'],
    [5, 'known'], [14.99, 'known'], [15, 'trusted'],
    [29.99, 'trusted'], [30, 'own'], [100, 'own'],
  ] as const;
  for (const [cred, css] of cases) assert.equal(getCredLevel(cred).css, css);
  assert.equal(getCredLevel(30).max, null);
  assert.equal(JSON.parse(JSON.stringify(getCredLevel(30))).max, null);
});

Deno.test('Credo progress preserves the web scale including maximum level', () => {
  assert.equal(getCredProgress(-1), 0);
  assert.equal(getCredProgress(0), 0);
  assert.equal(getCredProgress(5), 0.125);
  assert.equal(getCredProgress(29), 0.725);
  assert.equal(getCredProgress(30), 1);
  assert.equal(getCredProgress(100), 1);
});

Deno.test('Credo metadata is additive and never mutates user records', () => {
  const original = { id: 'user', cred: 14.5, nickname: 'name' };
  const result = withCredo(original);
  assert.deepEqual(original, { id: 'user', cred: 14.5, nickname: 'name' });
  assert.equal(result.id, original.id);
  assert.equal(result.nickname, original.nickname);
  assert.equal(result.credLevel.css, 'known');
  assert.equal(result.credProgress, 14.5 / 40);
});

Deno.test('canRate uses self, block, conversation and cooldown in order', () => {
  const context = {
    blockedPeerIds: new Set(['blocked']),
    conversationPartnerIds: new Set(['blocked', 'recent', 'eligible']),
    recentlyRatedIds: new Set(['blocked', 'recent']),
  };
  assert.deepEqual(canRate('me', 'me', context), { ok: false, reason: 'self' });
  assert.deepEqual(canRate('me', 'blocked', context), { ok: false, reason: 'user_blocked' });
  assert.deepEqual(canRate('me', 'stranger', context), { ok: false, reason: 'no_chat' });
  assert.deepEqual(canRate('me', 'recent', context), { ok: false, reason: '24h_limit' });
  assert.deepEqual(canRate('me', 'eligible', context), { ok: true });
});

Deno.test('eligibility pagination includes records beyond Supabase row cap', async () => {
  const rows = Array.from({ length: 1201 }, (_, id) => ({ id }));
  const ranges: number[][] = [];
  const result = await readAllRows((start, end) => {
    ranges.push([start, end]);
    return Promise.resolve({ data: rows.slice(start, end + 1), error: null });
  });
  assert.equal(result.length, 1201);
  assert.equal(result.at(-1)?.id, 1200);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
});

Deno.test('pagination fails closed on an error after an earlier successful page', async () => {
  const dbError = { message: 'database unavailable' };
  await assert.rejects(() => readAllRows((start) => Promise.resolve(start === 0
    ? { data: Array(500).fill({ id: 'previous' }), error: null }
    : { data: null, error: dbError })), (error) => error === dbError);
});

function fakeDatabase(failureTable?: string) {
  const observations: Array<{ table: string; filters: Array<unknown[]> }> = [];
  return {
    observations,
    from(table: string) {
      const filters: Array<unknown[]> = [];
      observations.push({ table, filters });
      const builder = {
        select(_fields: string) { return builder; },
        eq(field: string, value: unknown) { filters.push(['eq', field, value]); return builder; },
        is(field: string, value: unknown) { filters.push(['is', field, value]); return builder; },
        gt(field: string, value: unknown) { filters.push(['gt', field, value]); return builder; },
        order(_field: string) { return builder; },
        range(_start: number, _end: number) {
          if (table === failureTable) return Promise.resolve({ data: null, error: new Error('lookup failed') });
          const filterField = filters.find(([operator]) => operator === 'eq')?.[1];
          const data = table === 'messages'
            ? filterField === 'fromId' ? [{ toId: 'sent' }, { toId: null }] : [{ fromId: 'received' }]
            : table === 'rate_log' ? [{ to: 'recent' }]
            : filterField === 'blockerId' ? [{ blockedId: 'outgoing-block' }] : [{ blockerId: 'incoming-block' }];
          return Promise.resolve({ data, error: null });
        },
      };
      return builder;
    },
  };
}

Deno.test('rating context handles both chat/block directions and exact rolling cutoff', async () => {
  const db = fakeDatabase();
  const now = Date.parse('2026-10-14T10:00:00Z');
  const context = await loadRatingContext(db as never, 'me', now);
  assert.deepEqual([...context.conversationPartnerIds].sort(), ['received', 'sent']);
  assert.deepEqual([...context.blockedPeerIds].sort(), ['incoming-block', 'outgoing-block']);
  assert.deepEqual([...context.recentlyRatedIds], ['recent']);
  const rating = db.observations.find((query) => query.table === 'rate_log');
  assert.ok(rating?.filters.some((filter) =>
    filter[0] === 'gt' && filter[1] === 'date' && filter[2] === '2026-10-13T10:00:00.000Z'));
  for (const query of db.observations.filter((query) => query.table === 'messages')) {
    assert.ok(query.filters.some((filter) => filter[0] === 'is' && filter[1] === 'groupId' && filter[2] === null));
  }
});

Deno.test('a failed block lookup never produces a permissive rating context', async () => {
  await assert.rejects(() => loadRatingContext(fakeDatabase('user_blocks') as never, 'me'), /lookup failed/);
});
