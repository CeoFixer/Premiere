import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigError, env } from './config.js';

// Access tokens are compact, HMAC-signed pointers to a purchase:
//   base64url(JSON payload) + "." + base64url(HMAC-SHA256)
// They carry no secrets and are re-checked against Stripe on every play,
// so a refunded or disputed purchase stops working even if the link leaks.

function secret() {
  const value = env('ACCESS_TOKEN_SECRET');
  if (value.length < 32) throw new ConfigError('ACCESS_TOKEN_SECRET');
  return value;
}

function sign(data) {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createAccessToken({ email, sessionId }) {
  const payload = { v: 1, sub: email || '', sid: sessionId, iat: Math.floor(Date.now() / 1000) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyAccessToken(token) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload?.v !== 1 || typeof payload.sid !== 'string' || !payload.sid) return null;
    return payload;
  } catch {
    return null;
  }
}
