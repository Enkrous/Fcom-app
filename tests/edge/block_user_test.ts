import assert from 'node:assert/strict';
import { signJWT } from '../../supabase/functions/_shared/jwt.ts';

Deno.test('unblock remains scoped to the owner and works for rejected, moved or deleted targets', async () => {
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  const envNames = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const prior = envNames.map((name) => Deno.env.get(name));
  const secret = 'test_block_secret_at_least_32_characters';
  const callerId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  let callerStatus = 'approved';
  let target: { id: string; status: string; school: string } | null = null;
  let targetReads = 0;
  const deletes: URL[] = [];
  let handler: (request: Request) => Promise<Response>;
  Deno.env.set('JWT_SECRET', secret);
  Deno.env.set('SUPABASE_URL', 'http://localhost:54329');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  Object.defineProperty(Deno, 'serve', { value: (fn: typeof handler) => { handler = fn; }, configurable: true });
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    if (url.pathname.endsWith('/sessions')) return json({ id: 'active-session' });
    if (url.pathname.endsWith('/users')) {
      if (url.searchParams.get('id') === `eq.${callerId}`) {
        return json({ id: callerId, nickname: 'caller', status: callerStatus, school: 'Test', role: 'member' });
      }
      targetReads++;
      return json(target);
    }
    if (url.pathname.endsWith('/rate_limit_log')) {
      return new Response(null, { status: 200, headers: { 'Content-Range': '0-0/0' } });
    }
    if (url.pathname.endsWith('/user_blocks')) {
      if (request.method === 'DELETE') {
        deletes.push(url);
        return new Response(null, { status: 204 });
      }
      return json([]);
    }
    throw new Error(`unexpected test request ${request.url}`);
  };
  try {
    await import('../../supabase/functions/block-user/index.ts');
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    const token = await signJWT({ sub: callerId, jti: crypto.randomUUID(), iat: 1, exp: 4102444800 }, secret);
    const request = (action: string) => new Request('http://localhost/functions/v1/block-user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId, action }),
    });
    for (const staleTarget of [
      { id: targetId, status: 'rejected', school: 'Test' },
      { id: targetId, status: 'approved', school: 'Other school' },
      null,
    ]) {
      target = staleTarget;
      const response = await handler!(request('unblock'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).action, 'unblock');
    }
    assert.equal(targetReads, 0, 'unblock depends on the stale target profile');
    assert.equal(deletes.length, 3);
    for (const url of deletes) {
      assert.equal(url.searchParams.get('blockerId'), `eq.${callerId}`);
      assert.equal(url.searchParams.get('blockedId'), `eq.${targetId}`);
    }
    target = { id: targetId, status: 'rejected', school: 'Test' };
    const rejected = await handler!(request('block'));
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error, 'target_not_approved');
    target = { id: targetId, status: 'approved', school: 'Other school' };
    const crossSchool = await handler!(request('block'));
    assert.equal(crossSchool.status, 403);
    assert.equal((await crossSchool.json()).error, 'cross_school_forbidden');
    callerStatus = 'pending';
    assert.equal((await handler!(request('unblock'))).status, 403);
    assert.equal(deletes.length, 3, 'unapproved caller removed a block');
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    envNames.forEach((name, i) => prior[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, prior[i]!));
  }
});
