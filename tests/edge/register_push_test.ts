import assert from 'node:assert/strict';
import { signJWT } from '../../supabase/functions/_shared/jwt.ts';

Deno.test('register-push authorizes pending/approved sessions and scopes registration/unregistration', async () => {
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  const envNames = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'APNS_ENVIRONMENT'];
  const prior = envNames.map((name) => Deno.env.get(name));
  const secret = 'test_push_secret_at_least_32_characters';
  const callerId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const token = 'A'.repeat(64);
  let status = 'pending';
  let sessionExists = true;
  let quotaAllowed = true;
  let quotaOffline = false;
  let quotaCalls = 0;
  let writes = 0;
  const registrations: Array<Record<string, unknown>> = [];
  const deletions: URL[] = [];
  let handler: (req: Request) => Promise<Response>;
  Deno.env.set('JWT_SECRET', secret);
  Deno.env.set('SUPABASE_URL', 'http://localhost:54329');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  Deno.env.delete('APNS_ENVIRONMENT');
  Object.defineProperty(Deno, 'serve', { value: (fn: typeof handler) => { handler = fn; }, configurable: true });
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    const json = (body: unknown, code = 200) => Promise.resolve(Response.json(body, { status: code }));
    if (url.pathname.endsWith('/sessions')) return json(sessionExists ? { id: 'active' } : null);
    if (url.pathname.endsWith('/users')) return json({ id: callerId, nickname: 'test', status, school: 'Test', role: 'member' });
    if (url.pathname.endsWith('/rpc/consume_rate_limit')) {
      quotaCalls++;
      const body = await request.json();
      assert.equal(body.p_key, `register-push:${callerId}`);
      if (quotaOffline) return json({ code: 'XX000', message: 'test outage' }, 500);
      return json(quotaAllowed);
    }
    if (url.pathname.endsWith('/device_tokens')) {
      writes++;
      if (request.method === 'DELETE') {
        deletions.push(url);
        return new Response(null, { status: 204 });
      }
      assert.equal(request.method, 'POST');
      assert.equal(url.searchParams.get('on_conflict'), 'platform,environment,token');
      const body = await request.json();
      registrations.push(body);
      return json({ platform: body.platform, environment: body.environment,
        createdAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:01Z' });
    }
    throw new Error(`unexpected test request ${request.url}`);
  };
  try {
    await import('../../supabase/functions/register-push/index.ts');
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    const sessionToken = await signJWT({ sub: callerId, jti: crypto.randomUUID(), iat: 1, exp: 4102444800 }, secret);
    const request = (body: unknown, authorized = true) => new Request('http://localhost/functions/v1/register-push', {
      method: 'POST', headers: { Authorization: authorized ? `Bearer ${sessionToken}` : '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal((await handler!(request({ token }, false))).status, 401);
    assert.equal(quotaCalls, 0);
    for (const userStatus of ['pending', 'approved']) {
      status = userStatus;
      const response = await handler!(request({ token, userId: otherId }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.registered, true);
      assert.equal(body.device.environment, 'production');
      assert.ok(!('token' in body.device), 'registration response exposes token');
      assert.equal(registrations.at(-1)?.userId, callerId, 'body userId spoofed token ownership');
      assert.equal(registrations.at(-1)?.token, token.toLowerCase());
    }
    const invalid = await handler!(request({ token: 'bad' }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_token');
    assert.equal(writes, 2);
    const removed = await handler!(request({ token, action: 'unregister', environment: 'sandbox', userId: otherId }));
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).registered, false);
    assert.equal(deletions[0].searchParams.get('userId'), `eq.${callerId}`);
    assert.equal(deletions[0].searchParams.get('token'), `eq.${token.toLowerCase()}`);
    assert.equal(deletions[0].searchParams.get('environment'), 'eq.sandbox');
    status = 'rejected';
    assert.equal((await handler!(request({ token }))).status, 403);
    assert.equal(writes, 3);
    status = 'approved';
    quotaAllowed = false;
    assert.equal((await handler!(request({ token }))).status, 429);
    quotaOffline = true;
    assert.equal((await handler!(request({ token }))).status, 503);
    assert.equal(writes, 3);
    sessionExists = false;
    const revoked = await handler!(request({ token }));
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json()).error, 'session_revoked');
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    envNames.forEach((name, i) => prior[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, prior[i]!));
  }
});
