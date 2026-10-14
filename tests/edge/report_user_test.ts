import { signJWT } from '../../supabase/functions/_shared/jwt.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('report quota authenticates first and isolates two accounts sharing an IP', async () => {
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  const envNames = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const prior = envNames.map(name => Deno.env.get(name));
  const secret = 'test_report_secret_at_least_32_characters';
  let handler: (req: Request) => Promise<Response>;
  const counts = new Map<string, number>();
  let limiterCalls = 0;
  let limiterOffline = false;
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
    if (url.pathname.endsWith('/rpc/consume_rate_limit')) {
      limiterCalls++;
      if (limiterOffline) return json({ code: 'XX000', message: 'test outage' }, 500);
      const body = await request.json();
      const count = counts.get(body.p_key) ?? 0;
      if (count >= body.p_max) return json(false);
      counts.set(body.p_key, count + 1);
      return json(true);
    }
    if (url.pathname.endsWith('/sessions')) return json({ id: 'test-session' });
    if (url.pathname.endsWith('/users')) {
      const id = url.searchParams.get('id')?.slice(3);
      return json({ id, nickname: 'test', status: 'approved', school: 'Test', role: 'member' });
    }
    if (url.pathname.endsWith('/user_reports')) {
      if (request.method === 'POST') return json({ id: crypto.randomUUID(), ...await request.json() }, 201);
      return json(null);
    }
    throw new Error(`unexpected test request ${request.url}`);
  };
  try {
    await import('../../supabase/functions/report-user/index.ts');
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    const makeRequest = async (userId?: string) => {
      const token = userId ? await signJWT({ sub: userId, jti: crypto.randomUUID(), iat: 1, exp: 4102444800 }, secret) : '';
      return new Request('http://localhost/functions/v1/report-user', {
        method: 'POST',
        headers: { Authorization: token ? `Bearer ${token}` : '', 'x-forwarded-for': '192.0.2.1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: crypto.randomUUID(), reason: 'spam' }),
      });
    };
    const noAuth = await handler!(await makeRequest());
    assert(noAuth.status === 401 && limiterCalls === 0, 'unauthenticated request consumed a quota');
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    for (let i = 0; i < 5; i++) {
      const response = await handler!(await makeRequest(userA));
      assert(response.status === 200, `request ${i + 1} failed: ${await response.text()}`);
    }
    assert((await handler!(await makeRequest(userA))).status === 429, 'sixth request was allowed');
    assert((await handler!(await makeRequest(userB))).status === 200, 'another account shares exhausted quota');
    assert(counts.get(`reports:${userA}`) === 5 && counts.get(`reports:${userB}`) === 1, 'quota key is not account id');
    limiterOffline = true;
    const outage = await handler!(await makeRequest(userB));
    assert(outage.status === 503 && (await outage.json()).error === 'rate_limit_unavailable', 'database failure bypassed quota');
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    envNames.forEach((name, i) => prior[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, prior[i]!));
  }
});
