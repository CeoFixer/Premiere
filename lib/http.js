import { ConfigError, env } from './config.js';

const NO_STORE = { 'cache-control': 'no-store' };

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Wraps a handler so thrown errors become clean JSON without leaking internals.
export function handle(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.status, { error: error.code, message: error.message });
      }
      if (error instanceof ConfigError) {
        console.error(`[config] ${error.message}`);
        return json(503, { error: 'not_configured', message: 'This feature is not configured yet.' });
      }
      console.error('[api] unexpected error', error);
      return json(500, { error: 'server_error', message: 'Something went wrong. Please try again.' });
    }
  };
}

export async function readJson(request, maxBytes = 16 * 1024) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Expected application/json.');
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large', 'Request is too large.');
  try {
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

// Browsers always send Origin on cross-site POSTs; reject writes coming from other sites.
export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const allowed = new Set([new URL(request.url).origin]);
  const site = env('SITE_URL');
  if (site) allowed.add(new URL(site).origin);
  if (!allowed.has(origin)) throw new HttpError(403, 'forbidden_origin', 'Request origin is not allowed.');
}

export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

// Best-effort in-memory limiter (per instance). Enough to stop casual abuse of
// the e-mail and checkout endpoints without needing a database.
const buckets = new Map();

export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    if (buckets.size > 10000) {
      for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
    }
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new HttpError(429, 'too_many_requests', 'Too many requests. Please wait a few minutes and try again.');
  }
}

export function resetRateLimits() {
  buckets.clear();
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HttpError(400, 'invalid_email', 'Please enter a valid e-mail address.');
  }
  return email;
}

export function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}
