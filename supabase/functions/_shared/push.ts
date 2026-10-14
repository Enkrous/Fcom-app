import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';
import { readAllRows } from './credo.ts';

export type PushEnvironment = 'sandbox' | 'production';
export type ApnsConfig = {
  privateKey: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: PushEnvironment;
};

export function getPushEnvironment(value?: string): PushEnvironment {
  if (!value) return 'production';
  if (value === 'sandbox' || value === 'production') return value;
  throw new Error('invalid_apns_environment');
}

export function getApnsConfig(getEnv = (name: string) => Deno.env.get(name)): ApnsConfig | null {
  const privateKey = getEnv('APNS_PRIVATE_KEY')?.trim();
  const keyId = getEnv('APNS_KEY_ID')?.trim();
  const teamId = getEnv('APNS_TEAM_ID')?.trim();
  const bundleId = getEnv('APNS_BUNDLE_ID')?.trim();
  if (!privateKey || !keyId || !teamId || !bundleId) return null;
  return { privateKey, keyId, teamId, bundleId, environment: getPushEnvironment(getEnv('APNS_ENVIRONMENT')) };
}

export function normalizeIosDeviceToken(value: unknown): string | null {
  // Apple specifies variable-length tokens. Bound input size for the API,
  // without assuming today's common 32-byte token format.
  return typeof value === 'string' && value.length >= 2 && value.length <= 1024
    && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : null;
}

export function parsePushRegistration(body: unknown, defaultEnvironment: PushEnvironment) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false as const, error: 'invalid_body' };
  const input = body as Record<string, unknown>;
  if (!input.token) return { ok: false as const, error: 'token_required' };
  const token = normalizeIosDeviceToken(input.token);
  if (!token) return { ok: false as const, error: 'invalid_token' };
  const platform = input.platform ?? 'ios';
  if (platform !== 'ios') return { ok: false as const, error: 'invalid_platform' };
  const action = input.action ?? 'register';
  if (action !== 'register' && action !== 'unregister') return { ok: false as const, error: 'invalid_action' };
  const environment = input.environment ?? defaultEnvironment;
  if (environment !== 'production' && environment !== 'sandbox') return { ok: false as const, error: 'invalid_environment' };
  return { ok: true as const, value: { token, platform, action, environment } };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function createApnsProviderToken(config: ApnsConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const pem = config.privateKey.replace(/\\n/g, '\n');
  const encodedKey = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const keyBytes = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes.buffer,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: config.keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: config.teamId, iat: nowSeconds })));
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

let providerCache: { privateKey: string; keyId: string; teamId: string; issuedAt: number; promise: Promise<string> } | null = null;
function getProviderToken(config: ApnsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Apple permits refreshes every 20–60 minutes; reuse for 40 minutes and
  // share the promise so simultaneous notifications do not rotate the token.
  if (!providerCache || providerCache.privateKey !== config.privateKey || providerCache.keyId !== config.keyId
    || providerCache.teamId !== config.teamId || now < providerCache.issuedAt || now - providerCache.issuedAt >= 2400) {
    providerCache = {
      privateKey: config.privateKey, keyId: config.keyId, teamId: config.teamId,
      issuedAt: now, promise: createApnsProviderToken(config, now),
    };
  }
  return providerCache.promise;
}

export type PushEvent =
  | { type: 'message'; fromId: string; toId?: string; groupId?: string; messageId: string }
  | { type: 'approval_request' }
  | { type: 'account_approved'; userId: string };

export function createPushPayload(event: PushEvent): Record<string, unknown> {
  const body = event.type === 'message' ? 'У вас новое сообщение.'
    : event.type === 'approval_request' ? 'Поступила новая заявка на вступление.'
    : 'Ваш аккаунт одобрен. Можно войти в Fcom.';
  return {
    aps: { alert: { title: 'Fcom', body }, sound: 'default' },
    event: event.type,
    ...(event.type === 'message' ? { messageId: event.messageId, fromId: event.fromId, ...(event.groupId ? { groupId: event.groupId } : {}) } : {}),
  };
}

type ApnsOutcome = { ok: true } | { ok: false; status: number; reason: string; invalidatedAt?: number; retryable: boolean };
let httpClient: Deno.HttpClient | null = null;

export async function sendApnsNotification(
  config: ApnsConfig,
  token: string,
  payload: Record<string, unknown>,
  options: { signal?: AbortSignal; transport?: typeof fetch; timeoutMs?: number } = {},
): Promise<ApnsOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    const providerToken = await getProviderToken(config);
    const host = config.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const transport = options.transport ?? fetch;
    if (!options.transport && !httpClient) httpClient = Deno.createHttpClient({ http2: true, http1: false });
    const response = await transport(`https://${host}/3/device/${token}`, {
      method: 'POST', signal,
      ...(!options.transport ? { client: httpClient! } : {}),
      headers: {
        authorization: `bearer ${providerToken}`,
        'content-type': 'application/json',
        'apns-topic': config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'apns-id': crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    if (response.status === 200) { await response.body?.cancel(); return { ok: true }; }
    const data = await response.json().catch(() => ({}));
    return {
      ok: false, status: response.status, reason: typeof data.reason === 'string' ? data.reason : 'provider_error',
      ...(response.status === 410 && typeof data.timestamp === 'number' && Number.isFinite(data.timestamp)
        && data.timestamp >= 0 ? { invalidatedAt: data.timestamp } : {}),
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch {
    return { ok: false, status: 0, reason: 'transport_failed', retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

type DeviceRow = { userId: string; token: string; platform: string; environment: PushEnvironment; createdAt: string; updatedAt: string; registrationId: string };

export function shouldPruneDevice(row: DeviceRow, outcome: ApnsOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.status === 400 && outcome.reason === 'BadDeviceToken') return true;
  return outcome.status === 410 && ['Unregistered', 'ExpiredToken'].includes(outcome.reason)
    && outcome.invalidatedAt !== undefined && new Date(row.updatedAt).getTime() <= outcome.invalidatedAt;
}

async function recipientsForEvent(supabase: SupabaseClient, event: PushEvent, signal: AbortSignal): Promise<string[]> {
  if (event.type === 'approval_request') {
    const admins = await readAllRows<{ id: string }>((start, end) => supabase.from('users').select('id')
      .eq('role', 'admin').eq('status', 'approved').order('id').range(start, end).abortSignal(signal));
    return admins.map((user) => user.id);
  }
  let ids: string[];
  if (event.type === 'account_approved') ids = [event.userId];
  else if (event.groupId) {
    const members = await readAllRows<{ userId: string }>((start, end) => supabase.from('group_members').select('"userId"')
      .eq('groupId', event.groupId).neq('userId', event.fromId).order('userId').range(start, end).abortSignal(signal));
    ids = members.map((member) => member.userId);
  } else ids = event.toId ? [event.toId] : [];
  const approved: string[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await supabase.from('users').select('id').in('id', ids.slice(start, start + 100))
      .eq('status', 'approved').abortSignal(signal);
    if (error) throw error;
    approved.push(...(data ?? []).map((user) => user.id));
  }
  if (event.type === 'message' && event.toId && approved.length) {
    const { data, error } = await supabase.from('user_blocks').select('"blockerId"')
      .or(`and("blockerId".eq.${event.fromId},"blockedId".eq.${event.toId}),and("blockerId".eq.${event.toId},"blockedId".eq.${event.fromId})`)
      .limit(1).abortSignal(signal);
    if (error) throw error;
    if (data?.length) return [];
  }
  return [...new Set(approved)];
}

export async function sendPushForEvent(
  supabase: SupabaseClient,
  event: PushEvent,
  options: { config?: ApnsConfig | null; transport?: typeof fetch } = {},
) {
  const config = options.config === undefined ? getApnsConfig() : options.config;
  if (!config) return { enabled: false, sent: 0, failed: 0, pruned: 0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const stats = { enabled: true, sent: 0, failed: 0, pruned: 0 };
  try {
    const userIds = await recipientsForEvent(supabase, event, controller.signal);
    const devices: DeviceRow[] = [];
    for (let start = 0; start < userIds.length; start += 100) {
      devices.push(...await readAllRows<DeviceRow>((first, last) => supabase.from('device_tokens')
        .select('"userId", token, platform, environment, "createdAt", "updatedAt", "registrationId"')
        .in('userId', userIds.slice(start, start + 100)).eq('platform', 'ios').eq('environment', config.environment)
        .order('token').range(first, last).abortSignal(controller.signal)));
    }
    const payload = createPushPayload(event);
    // Bounded concurrency and deadline keep a large group from retaining an
    // Edge worker indefinitely. The chat/approval mutation has already committed.
    for (let start = 0; start < devices.length && !controller.signal.aborted; start += 6) {
      await Promise.all(devices.slice(start, start + 6).map(async (device) => {
        const outcome = await sendApnsNotification(config, device.token, payload, {
          signal: controller.signal, transport: options.transport,
        });
        if (outcome.ok) { stats.sent++; return; }
        stats.failed++;
        console.warn('APNs request rejected', { status: outcome.status, reason: outcome.reason, retryable: outcome.retryable });
        if (shouldPruneDevice(device, outcome)) {
          let deletion = supabase.from('device_tokens').delete()
            .eq('userId', device.userId).eq('platform', device.platform).eq('environment', device.environment)
            .eq('token', device.token).eq('updatedAt', device.updatedAt).eq('registrationId', device.registrationId);
          // Enforce the APNs invalidation cutoff in Postgres too: timestamps
          // there preserve microseconds, while JavaScript Date uses milliseconds.
          if (outcome.status === 410 && outcome.invalidatedAt !== undefined) {
            deletion = deletion.lte('updatedAt', new Date(outcome.invalidatedAt).toISOString());
          }
          const { data, error } = await deletion.select('token').abortSignal(controller.signal);
          if (!error) stats.pruned += data?.length ?? 0;
        }
      }));
    }
    if (controller.signal.aborted) console.warn('APNs fanout deadline reached');
    return stats;
  } finally {
    clearTimeout(timeout);
  }
}

export function queuePushForEvent(supabase: SupabaseClient, event: PushEvent): void {
  const task = Promise.resolve().then(() => sendPushForEvent(supabase, event)).catch(() => {
    // Never include secrets, device tokens, message text or database details.
    console.warn('Push task failed; the original operation remains successful');
  });
  const runtime = (globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil(task: Promise<unknown>): void } }).EdgeRuntime;
  try { runtime?.waitUntil(task); }
  catch { console.warn('Push background registration failed'); }
}
