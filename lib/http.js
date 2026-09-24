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
  const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip') || 'unknown';
  return ipKey(ip);
}

// One IPv6 client usually owns a whole /64, so limits are keyed by that prefix.
function ipKey(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Best-effort in-memory limiter (per instance). Enough to stop casual abuse of
// the e-mail and checkout endpoints without needing a database. Each limiter
// ("restore", "film", ...) has its own table, so flooding one endpoint can't
// push another endpoint's counters out.
const tables = new Map();
const MAX_KEYS = 50000;

export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const name = key.split(':')[0];
  let buckets = tables.get(name);
  if (!buckets) tables.set(name, (buckets = new Map()));
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
      // Still full: drop the oldest tenth (Map keeps insertion order).
      if (buckets.size >= MAX_KEYS) {
        let drop = Math.ceil(MAX_KEYS / 10);
        for (const k of buckets.keys()) {
          buckets.delete(k);
          if (--drop === 0) break;
        }
      }
    }
    buckets.delete(key);
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new HttpError(429, 'too_many_requests', 'Too many requests. Please wait a few minutes and try again.');
  }
}

export function resetRateLimits() {
  tables.clear();
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
