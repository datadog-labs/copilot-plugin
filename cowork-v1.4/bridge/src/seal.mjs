// Stateless sealing. Everything the bridge must remember between requests (sign-in state, authorization
// codes, refresh tokens) travels inside AES-256-GCM envelopes, so the bridge keeps no token store.
// Client credentials are derived with HMAC, so registration needs no database either.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const SALT = Buffer.from('datadog-cowork-bridge/v1');

export const b64u = buf => Buffer.from(buf).toString('base64url');
export const now = () => Math.floor(Date.now() / 1000);

/** Constant-time string comparison (length leak only). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 7636 S256 challenge for a verifier. */
export const s256 = verifier => b64u(createHash('sha256').update(verifier).digest());

/** 43-128 char PKCE verifier (RFC 7636 section 4.1). */
export const newVerifier = () => b64u(randomBytes(48)); // 64 chars

export function createSealer(secret) {
  const derive = info => Buffer.from(hkdfSync('sha256', secret, SALT, Buffer.from(info), 32));
  const sealKey = derive('seal/aes-256-gcm');
  const clientIdKey = derive('client-id/hmac-sha256');
  const clientSecretKey = derive('client-secret/hmac-sha256');

  /** Seal obj for one purpose. The purpose is authenticated data: a sealed state cannot pass as a code. */
  function seal(purpose, obj) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sealKey, iv);
    cipher.setAAD(Buffer.from(`${VERSION}:${purpose}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return `${VERSION}.${b64u(Buffer.concat([iv, body, cipher.getAuthTag()]))}`;
  }

  /** Open a sealed value; null when tampered, wrong purpose, malformed or expired (obj.exp, seconds). */
  function open(purpose, token) {
    if (typeof token !== 'string' || token.length > 16384 || !token.startsWith(`${VERSION}.`)) return null;
    try {
      const raw = Buffer.from(token.slice(VERSION.length + 1), 'base64url');
      if (raw.length < 12 + 16 + 2) return null;
      const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), body = raw.subarray(12, raw.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', sealKey, iv);
      decipher.setAAD(Buffer.from(`${VERSION}:${purpose}`));
      decipher.setAuthTag(tag);
      const obj = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.exp === 'number' && obj.exp < now()) return null;
      return obj;
    } catch {
      return null;
    }
  }

  // client_id = ddb_<nonce>.<mac>: verifiable without storage, short enough for any token store.
  function newClientId() {
    const nonce = b64u(randomBytes(12));
    return `ddb_${nonce}.${b64u(createHmac('sha256', clientIdKey).update(nonce).digest()).slice(0, 22)}`;
  }
  function isClientId(id) {
    const m = /^ddb_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})$/.exec(String(id || ''));
    if (!m) return false;
    return safeEqual(m[2], b64u(createHmac('sha256', clientIdKey).update(m[1]).digest()).slice(0, 22));
  }
  const clientSecret = id => b64u(createHmac('sha256', clientSecretKey).update(String(id)).digest());
  const checkClientSecret = (id, secret) => isClientId(id) && typeof secret === 'string' && safeEqual(secret, clientSecret(id));

  return { seal, open, newClientId, isClientId, clientSecret, checkClientSecret };
}
