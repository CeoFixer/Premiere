// Runtime configuration. Every secret comes from environment variables —
// nothing sensitive is ever committed or sent to the browser.

export class ConfigError extends Error {
  constructor(name) {
    super(`Missing required environment variable ${name}`);
    this.name = 'ConfigError';
    this.variable = name;
  }
}

export function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

export function requireEnv(name) {
  const value = env(name);
  if (!value) throw new ConfigError(name);
  return value;
}

export function list(name) {
  return env(name)
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Public origin of the site, used for Stripe redirect URLs and e-mailed links.
// SITE_URL is required: without it a forged Host header could make the server
// e-mail a buyer's link pointing at someone else's domain. Only local
// development (localhost) may fall back to the request origin.
export function siteUrl(request) {
  const configured = env('SITE_URL');
  if (configured) return configured.replace(/\/+$/, '');
  const origin = new URL(request.url);
  if (LOCAL_HOSTS.has(origin.hostname)) return origin.origin;
  throw new ConfigError('SITE_URL');
}

export const FILM = Object.freeze({
  id: 'la-plage',
  title: 'La Plage',
  description: 'Feature film — lifetime streaming access on Fixer Premiere',
  currency: 'usd',
  get priceCents() {
    const cents = Number.parseInt(env('FILM_PRICE_CENTS', '700'), 10);
    return Number.isFinite(cents) && cents >= 50 ? cents : 700;
  },
});

export const DONATION = Object.freeze({
  id: 'donation',
  title: 'Donation to Fixer Premiere',
  minCents: 100,
  maxCents: 100000,
});

export const SUPPORT_EMAIL = 'support@fixer-app.com';
