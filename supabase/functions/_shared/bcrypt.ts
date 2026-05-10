/**
 * _shared/bcrypt.ts
 * Password hashing via Web Crypto PBKDF2.
 * No external deps — natively supported in Deno / Supabase Edge Functions.
 * Hash format: "pbkdf2:sha256:100000:<saltHex>:<hashHex>"
 */

const ITERATIONS = 100_000;
const HASH_ALGO  = 'SHA-256';
const KEY_ALGO   = 'PBKDF2';

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const arr = hex.match(/.{2}/g) ?? [];
  return new Uint8Array(arr.map(b => parseInt(b, 16)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), KEY_ALGO, false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: KEY_ALGO, salt, iterations: ITERATIONS, hash: HASH_ALGO },
    keyMaterial, 256,
  );
  return `pbkdf2:sha256:${ITERATIONS}:${toHex(salt.buffer)}:${toHex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || !stored.startsWith('pbkdf2:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 5) return false;
  const salt = fromHex(parts[3]);
  const expectedHash = parts[4];
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), KEY_ALGO, false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: KEY_ALGO, salt, iterations: ITERATIONS, hash: HASH_ALGO },
    keyMaterial, 256,
  );
  return toHex(bits) === expectedHash;
}
