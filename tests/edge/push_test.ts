import assert from 'node:assert/strict';
import {
  createApnsProviderToken, createPushPayload, getApnsConfig, getPushEnvironment,
  normalizeIosDeviceToken, parsePushRegistration, sendApnsNotification,
  sendPushForEvent, shouldPruneDevice,
} from '../../supabase/functions/_shared/push.ts';
import type { ApnsConfig } from '../../supabase/functions/_shared/push.ts';

async function signingFixture() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
  const config: ApnsConfig = { privateKey: pem, keyId: 'ABC123DEFG', teamId: 'DEF123GHIJ', bundleId: 'com.example.test', environment: 'production' };
  return { config, publicKey: keyPair.publicKey };
}

function decode(value: string) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)); }

Deno.test('push registration validates variable-length hex iOS tokens, actions and environment', () => {
  assert.equal(normalizeIosDeviceToken('A'.repeat(64)), 'a'.repeat(64));
  assert.equal(normalizeIosDeviceToken('B'.repeat(128)), 'b'.repeat(128));
  assert.equal(normalizeIosDeviceToken('AB'), 'ab');
  assert.equal(normalizeIosDeviceToken('a'.repeat(1026)), null);
  for (const token of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '<' + 'a'.repeat(64) + '>', ' ' + 'a'.repeat(64), 5]) {
    assert.equal(normalizeIosDeviceToken(token), null);
  }
  const token = 'a'.repeat(64);
  const parsed = parsePushRegistration({ token }, 'production');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { token, platform: 'ios', action: 'register', environment: 'production' });
  for (const [body, error] of [
    [null, 'invalid_body'], [[], 'invalid_body'], [{}, 'token_required'],
    [{ token: 'bad' }, 'invalid_token'], [{ token, platform: 'android' }, 'invalid_platform'],
    [{ token, action: 'delete-all' }, 'invalid_action'], [{ token, environment: 'test' }, 'invalid_environment'],
  ] as const) {
    const result = parsePushRegistration(body, 'production');
    assert.ok(!result.ok);
    assert.equal(result.error, error);
  }
  assert.equal(getPushEnvironment(undefined), 'production');
  assert.equal(getPushEnvironment('sandbox'), 'sandbox');
  assert.throws(() => getPushEnvironment('test'), /invalid_apns_environment/);
});

Deno.test('missing APNs credentials disable push before touching the database or network', async () => {
  assert.equal(getApnsConfig(() => undefined), null);
  assert.equal(getApnsConfig((name) => name === 'APNS_PRIVATE_KEY' ? 'partial' : undefined), null);
  const db = { from: () => { throw new Error('disabled push queried a database'); } };
  const result = await sendPushForEvent(db as never, { type: 'approval_request' }, { config: null });
  assert.deepEqual(result, { enabled: false, sent: 0, failed: 0, pruned: 0 });
});

Deno.test('APNs JWT uses ES256, Apple claims and a verifiable 64-byte signature', async () => {
  const { config, publicKey } = await signingFixture();
  const token = await createApnsProviderToken(config, 1791972000);
  const [header, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decode(header))), { alg: 'ES256', kid: config.keyId });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decode(claims))), { iss: config.teamId, iat: 1791972000 });
  assert.equal(decode(signature).length, 64);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
    decode(signature).buffer as ArrayBuffer, new TextEncoder().encode(`${header}.${claims}`)), true);
  const escaped = { ...config, privateKey: config.privateKey.replaceAll('\n', '\\n') };
  assert.equal((await createApnsProviderToken(escaped)).split('.').length, 3);
});

Deno.test('APNs requests select the environment and reuse provider tokens for generic alerts', async () => {
  const { config } = await signingFixture();
  const requests: Request[] = [];
  const transport: typeof fetch = (input, options) => {
    requests.push(new Request(input, options));
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const payload = createPushPayload({ type: 'message', fromId: 'sender', toId: 'recipient', messageId: 'message' });
  assert.equal((await sendApnsNotification(config, 'a'.repeat(64), payload, { transport })).ok, true);
  assert.equal((await sendApnsNotification({ ...config, environment: 'sandbox' }, 'a'.repeat(64), payload, { transport })).ok, true);
  assert.equal(new URL(requests[0].url).host, 'api.push.apple.com');
  assert.equal(new URL(requests[1].url).host, 'api.sandbox.push.apple.com');
  assert.equal(requests[0].headers.get('authorization'), requests[1].headers.get('authorization'));
  assert.equal(requests[0].headers.get('apns-topic'), config.bundleId);
  assert.equal(requests[0].headers.get('apns-push-type'), 'alert');
  assert.equal(requests[0].headers.get('apns-priority'), '10');
  const body = await requests[0].json();
  assert.equal(body.aps.alert.body, 'У вас новое сообщение.');
  assert.equal(body.messageId, 'message');
  assert.equal(body.fromId, 'sender'); // Native clients can open /messages?partnerId=fromId.
  assert.ok(!('toId' in body) && !('text' in body) && !('fullName' in body) && !('phone' in body));
});

Deno.test('APNs errors prune only confirmed invalid devices and respect invalidation time', async () => {
  const { config } = await signingFixture();
  const row = { userId: 'user', token: 'a'.repeat(64), platform: 'ios', environment: 'production' as const,
    createdAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z', registrationId: 'first-registration' };
  for (const [status, reason, timestamp, expected] of [
    [400, 'BadDeviceToken', undefined, true], [400, 'DeviceTokenNotForTopic', undefined, false],
    [403, 'InvalidProviderToken', undefined, false], [500, 'InternalServerError', undefined, false],
    [410, 'Unregistered', Date.parse('2026-10-14T10:01:00Z'), true],
    [410, 'ExpiredToken', Date.parse('2026-10-14T09:59:00Z'), false], [410, 'Unregistered', undefined, false],
  ] as const) {
    const transport: typeof fetch = () => Promise.resolve(Response.json({ reason, timestamp }, { status }));
    const outcome = await sendApnsNotification(config, row.token, {}, { transport });
    assert.equal(shouldPruneDevice(row, outcome), expected, reason);
  }
});

Deno.test('APNs network errors and deadlines return bounded best-effort failures', async () => {
  const { config } = await signingFixture();
  const transport: typeof fetch = (_input, options) => new Promise((_resolve, reject) => {
    if (options?.signal?.aborted) reject(new Error('aborted'));
    else options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const start = Date.now();
  const result = await sendApnsNotification(config, 'a'.repeat(64), {}, { transport, timeoutMs: 5 });
  assert.ok(!result.ok);
  assert.equal(result.status, 0);
  assert.equal(result.retryable, true);
  assert.ok(Date.now() - start < 1000);
});

Deno.test('a stale APNs failure cannot delete a token re-registered while sending', async () => {
  const { config } = await signingFixture();
  const snapshot = { userId: 'user', token: 'a'.repeat(64), platform: 'ios', environment: 'production' as const,
    createdAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z', registrationId: 'first-registration' };
  let current = { ...snapshot };
  const filters: Array<[string, unknown]> = [];
  let pruneAttempted = false;
  const db = {
    from(table: string) {
      let deleting = false;
      const localFilters: Array<[string, unknown]> = [];
      const query = {
        select(_fields: string) { return query; },
        in(_field: string, _values: string[]) { return query; },
        eq(field: string, value: unknown) { localFilters.push([field, value]); return query; },
        lte(field: string, value: unknown) { localFilters.push(['cutoff:' + field, value]); return query; },
        order(_field: string) { return query; }, range(_first: number, _last: number) { return query; },
        abortSignal(_signal: AbortSignal) { return query; },
        delete() { deleting = true; pruneAttempted = true; return query; },
        then(resolve: (value: unknown) => unknown) {
          if (deleting) {
            filters.push(...localFilters);
            const matches = localFilters.every(([field, value]) => field.startsWith('cutoff:')
              ? new Date(current.updatedAt).getTime() <= new Date(String(value)).getTime()
              : current[field as keyof typeof current] === value);
            return Promise.resolve(resolve({ data: matches ? [{ token: current.token }] : [], error: null }));
          }
          return Promise.resolve(resolve({ data: table === 'users' ? [{ id: 'user' }] : [{ ...snapshot }], error: null }));
        },
      };
      return query;
    },
  };
  const transport: typeof fetch = () => {
    current = { ...snapshot, registrationId: 'new-registration' };
    return Promise.resolve(Response.json({ reason: 'Unregistered', timestamp: Date.parse('2026-10-14T10:01:00Z') }, { status: 410 }));
  };
  const stats = await sendPushForEvent(db as never, { type: 'account_approved', userId: 'user' }, { config, transport });
  assert.ok(pruneAttempted);
  assert.ok(filters.some(([field, value]) => field === 'userId' && value === snapshot.userId));
  assert.ok(filters.some(([field, value]) => field === 'updatedAt' && value === snapshot.updatedAt));
  assert.ok(filters.some(([field, value]) => field === 'registrationId' && value === snapshot.registrationId));
  assert.ok(filters.some(([field]) => field === 'cutoff:updatedAt'));
  assert.equal(stats.pruned, 0);
});
