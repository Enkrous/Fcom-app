import { cleanupQueuedChatMedia } from '../../supabase/functions/_shared/media_cleanup.ts';

type Client = Parameters<typeof cleanupQueuedChatMedia>[0];
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function fixture(failure?: 'queue' | 'references' | 'storage' | 'acknowledge') {
  const removed: string[][] = [];
  const acknowledged: string[][] = [];
  const databaseError = new Error('injected dependency failure');
  const client = {
    from: () => ({
      select: () => ({ order: () => ({ limit: async () => ({
        data: [{ path: 'deleted-user/orphan.png' }, { path: 'deleted-user/group.png' }],
        error: failure === 'queue' ? databaseError : null,
      }) }) }),
      delete: () => ({ in: async (_column: string, paths: string[]) => {
        acknowledged.push(paths);
        return { error: failure === 'acknowledge' ? databaseError : null };
      } }),
    }),
    rpc: async () => ({
      data: [{ path: 'deleted-user/group.png' }],
      error: failure === 'references' ? databaseError : null,
    }),
    storage: { from: () => ({ remove: async (paths: string[]) => {
      removed.push(paths);
      return { error: failure === 'storage' ? databaseError : null };
    } }) },
  } as unknown as Client;
  return { client, removed, acknowledged };
}

Deno.test('chat cleanup preserves group media and acknowledges only after Storage succeeds', async () => {
  const test = fixture();
  const count = await cleanupQueuedChatMedia(test.client);
  assert(count === 1, 'removed count must exclude live group media');
  assert(JSON.stringify(test.removed) === JSON.stringify([['deleted-user/orphan.png']]),
    'live group attachment must never be passed to Storage.remove');
  assert(test.acknowledged.length === 1 && test.acknowledged[0].length === 2,
    'orphan and retained references must leave the queue after a successful pass');
});

for (const failure of ['queue', 'references', 'storage', 'acknowledge'] as const) {
  Deno.test(`chat cleanup fails safely when ${failure} is unavailable`, async () => {
    const test = fixture(failure);
    let failed = false;
    try { await cleanupQueuedChatMedia(test.client); } catch { failed = true; }
    assert(failed, 'dependency failure must remain observable to the caller');
    if (failure === 'queue' || failure === 'references') {
      assert(test.removed.length === 0, 'unknown DB reference safety must prevent Storage deletion');
    }
    if (failure !== 'acknowledge') {
      assert(test.acknowledged.length === 0, 'failed cleanup must leave paths queued for retry');
    }
    for (const batch of test.removed) {
      assert(!batch.includes('deleted-user/group.png'), 'failures must never purge a surviving attachment');
    }
  });
}
