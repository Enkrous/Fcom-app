import assert from 'node:assert/strict';
import { signJWT } from '../../supabase/functions/_shared/jwt.ts';

Deno.test('upload-media finalization prevents orphan uploads after deletion and keeps failed cleanup durable', async () => {
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  const envNames = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const prior = envNames.map((name) => Deno.env.get(name));
  const secret = 'test_upload_secret_at_least_32_characters';
  const callerId = crypto.randomUUID();
  const unrelatedPath = `${crypto.randomUUID()}/previous/keep.png`;
  let finalize: 'success' | 'deleted' | 'error' | 'malformed' = 'success';
  let uploadFails = false;
  let removeFails = false;
  let uploadedPath = '';
  let operations: string[] = [];
  let queued = new Set<string>([unrelatedPath]);
  let handler: (req: Request) => Promise<Response>;
  Deno.env.set('JWT_SECRET', secret);
  Deno.env.set('SUPABASE_URL', 'http://localhost:54329');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  Object.defineProperty(Deno, 'serve', { value: (fn: typeof handler) => { handler = fn; }, configurable: true });
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
    if (url.pathname.endsWith('/sessions')) return json({ id: 'active-session' });
    if (url.pathname.endsWith('/users')) {
      assert.equal(url.searchParams.get('id'), `eq.${callerId}`);
      return json({ id: callerId, nickname: 'caller', status: 'approved', school: 'Test', role: 'member' });
    }
    const uploadPrefix = '/storage/v1/object/chat-media/';
    if (url.pathname.startsWith(uploadPrefix)) {
      assert.equal(request.method, 'POST');
      uploadedPath = decodeURIComponent(url.pathname.slice(uploadPrefix.length));
      assert.match(uploadedPath, new RegExp(`^${callerId}/\\d{4}-\\d{2}-\\d{2}/[0-9a-f-]+\\.png$`));
      operations.push('upload');
      if (uploadFails) return json({ message: 'test upload outage', error: 'ServiceUnavailable' }, 503);
      return json({ Id: crypto.randomUUID(), Key: `chat-media/${uploadedPath}` });
    }
    if (url.pathname.endsWith('/rpc/finalize_chat_media_upload')) {
      const body = await request.json();
      assert.equal(body.p_user_id, callerId);
      assert.equal(body.p_path, uploadedPath);
      operations.push('finalize');
      if (finalize === 'error') return json({ code: 'XX000', message: 'private test database outage' }, 500);
      if (finalize === 'malformed') return json({ unexpected: true });
      if (finalize === 'deleted') queued.add(uploadedPath);
      return json(finalize === 'success');
    }
    if (url.pathname.endsWith('/chat_media_cleanup_queue')) {
      if (request.method === 'POST') {
        assert.equal(url.searchParams.get('on_conflict'), 'path');
        const body = await request.json();
        assert.deepEqual(body, { path: uploadedPath });
        operations.push('enqueue');
        queued.add(uploadedPath);
        return new Response(null, { status: 201 });
      }
      assert.equal(request.method, 'DELETE');
      assert.equal(url.searchParams.get('path'), `eq.${uploadedPath}`);
      assert.ok(queued.has(uploadedPath));
      operations.push('acknowledge');
      queued.delete(uploadedPath);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/storage/v1/object/chat-media') {
      assert.equal(request.method, 'DELETE');
      const body = await request.json();
      assert.deepEqual(body.prefixes, [uploadedPath], 'cleanup removed another or previously published object');
      assert.ok(queued.has(uploadedPath), 'Storage removal happened before durable queue insertion');
      operations.push('remove');
      if (removeFails) return json({ message: 'test removal outage', error: 'ServiceUnavailable' }, 503);
      return json([{ name: uploadedPath }]);
    }
    throw new Error(`unexpected test request ${request.method} ${request.url}`);
  };
  try {
    await import('../../supabase/functions/upload-media/index.ts');
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    const token = await signJWT({ sub: callerId, jti: crypto.randomUUID(), iat: 1, exp: 4102444800 }, secret);
    const request = () => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'proof.png', { type: 'image/png' }));
      form.append('width', '640');
      form.append('height', '480');
      return new Request('http://localhost/functions/v1/upload-media', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      });
    };
    const reset = () => {
      operations = [];
      queued = new Set([unrelatedPath]);
      uploadedPath = '';
      uploadFails = false;
      removeFails = false;
    };

    const success = await handler!(request());
    assert.equal(success.status, 200);
    const body = await success.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.media, { path: uploadedPath, mime: 'image/png', bytes: 4, width: 640, height: 480 });
    assert.deepEqual(operations, ['upload', 'finalize']);
    assert.deepEqual([...queued], [unrelatedPath]);

    reset();
    finalize = 'deleted';
    const deleted = await handler!(request());
    assert.equal(deleted.status, 401);
    assert.deepEqual(await deleted.json(), { ok: false, error: 'session_revoked' });
    assert.deepEqual(operations, ['upload', 'finalize', 'enqueue', 'remove', 'acknowledge']);
    assert.deepEqual([...queued], [unrelatedPath]);

    for (const failure of ['error', 'malformed'] as const) {
      reset();
      finalize = failure;
      const response = await handler!(request());
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { ok: false, error: 'upload_failed' });
      assert.deepEqual(operations, ['upload', 'finalize', 'enqueue', 'remove', 'acknowledge']);
      assert.deepEqual([...queued], [unrelatedPath]);
    }

    reset();
    finalize = 'deleted';
    removeFails = true;
    const removalOutage = await handler!(request());
    assert.equal(removalOutage.status, 401);
    assert.deepEqual(await removalOutage.json(), { ok: false, error: 'session_revoked' });
    assert.deepEqual(operations, ['upload', 'finalize', 'enqueue', 'remove']);
    assert.ok(queued.has(uploadedPath), 'failed Storage removal lost its durable cleanup entry');
    assert.ok(queued.has(unrelatedPath), 'targeted cleanup touched another path');

    reset();
    finalize = 'success';
    uploadFails = true;
    const uploadOutage = await handler!(request());
    assert.equal(uploadOutage.status, 500);
    assert.deepEqual(await uploadOutage.json(), { ok: false, error: 'upload_failed' });
    assert.deepEqual(operations, ['upload', 'enqueue', 'remove', 'acknowledge']);
    assert.deepEqual([...queued], [unrelatedPath]);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true });
    envNames.forEach((name, i) => prior[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, prior[i]!));
  }
});
