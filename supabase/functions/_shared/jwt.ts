/**
 * _shared/jwt.ts
 * Custom JWT utilities — HS256, no external dependency.
 * Used instead of Supabase Auth to support the custom status flow.
 */

import { getServiceClient } from './db.ts';

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return Uint8Array.from(data).buffer;
}

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(enc.encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface JWTPayload {
  sub:       string;   // userId
  jti:       string;   // session id (UUID) — used for server-side revocation
  iat:       number;
  exp:       number;
  // Extended claims — included in login JWT for quick access without a DB round-trip
  nickname?: string;   // user's nickname
  status?:   string;   // 'approved' | 'pending' | 'rejected'
  school?:   string;   // school name — used for cross-school access checks
}

/** Signs and returns a JWT string. exp is a Unix timestamp. */
export async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body   = base64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;

  const key = await hmacKey(secret);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, toArrayBuffer(enc.encode(signingInput)));
  const sig = base64url(new Uint8Array(sigBuffer));

  return `${signingInput}.${sig}`;
}

/** Verifies and returns the payload, or throws on invalid/expired token. */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_token');

  const [header, body, sig] = parts;
  const enc = new TextEncoder();
  const signingInput = `${header}.${body}`;

  const key = await hmacKey(secret);
  const sigBuffer = toArrayBuffer(base64urlDecode(sig));

  const valid = await crypto.subtle.verify('HMAC', key, sigBuffer, toArrayBuffer(enc.encode(signingInput)));
  if (!valid) throw new Error('invalid_token');

  const payload: JWTPayload = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token_expired');
  }

  return payload;
}

/** Extracts and verifies Bearer token from the Authorization header. */
export async function requireAuth(req: Request, secret: string): Promise<JWTPayload> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('missing_token');
  return verifyJWT(token, secret);
}

/**
 * Like requireAuth, but also checks that the session jti still exists
 * in the sessions table (enables server-side token revocation via /logout).
 */
export async function requireAuthWithRevocation(
  req: Request,
  secret: string,
  supabase: ReturnType<typeof getServiceClient>,
): Promise<JWTPayload> {
  const payload = await requireAuth(req, secret);

  const { data: session } = await supabase
    .from('sessions')
    .select('id')
    .eq('jti', payload.jti)
    .maybeSingle();

  if (!session) throw new Error('session_revoked');

  return payload;
}
