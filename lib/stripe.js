import Stripe from 'stripe';
import { FILM, list, requireEnv } from './config.js';

let client = null;
let override = null;

export function stripe() {
  if (override) return override;
  if (!client) {
    client = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
      maxNetworkRetries: 2,
      timeout: 20000,
      appInfo: { name: 'fixer-premiere' },
    });
  }
  return client;
}

// Tests inject a fake client instead of talking to Stripe.
export function setStripeClient(fake) {
  override = fake;
  purchaseCache.clear();
}

const PAID = new Set(['paid', 'no_payment_required']);
const LEGACY_PREFIX = 'legacy:';
const purchaseCache = new Map();
const CACHE_MS = 5 * 60 * 1000;

export function isFilmSession(session) {
  return Boolean(session && session.mode === 'payment' && session.metadata?.item === FILM.id);
}

export function isPaidSession(session) {
  return Boolean(session && session.status === 'complete' && PAID.has(session.payment_status));
}

// Buyers from the old Wix site (Pricing Plans) keep access: their e-mails are
// listed in LEGACY_BUYER_EMAILS on the server, never in the code.
export function isLegacyBuyer(email) {
  if (!email) return false;
  return list('LEGACY_BUYER_EMAILS').some((item) => item.toLowerCase() === email.toLowerCase());
}

export function legacySessionId(email) {
  return `${LEGACY_PREFIX}${email.toLowerCase()}`;
}

// Checks that a purchase is still valid (paid, not refunded, not disputed).
export async function checkFilmPurchase(sessionId) {
  if (sessionId.startsWith(LEGACY_PREFIX)) {
    const email = sessionId.slice(LEGACY_PREFIX.length);
    return isLegacyBuyer(email) ? { ok: true, email } : { ok: false, reason: 'revoked' };
  }
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,}$/.test(sessionId)) return { ok: false, reason: 'not_found' };

  const cached = purchaseCache.get(sessionId);
  if (cached && cached.until > Date.now()) return cached.result;

  let session;
  try {
    session = await stripe().checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.latest_charge'],
    });
  } catch (error) {
    if (error?.statusCode === 404 || error?.code === 'resource_missing') return { ok: false, reason: 'not_found' };
    throw error;
  }

  let result;
  if (!isFilmSession(session)) result = { ok: false, reason: 'not_found' };
  else if (!isPaidSession(session)) result = { ok: false, reason: 'unpaid' };
  else {
    const charge = session.payment_intent?.latest_charge;
    if (charge && typeof charge === 'object' && (charge.refunded || charge.disputed)) {
      result = { ok: false, reason: 'refunded' };
    } else {
      result = { ok: true, email: session.customer_details?.email || '' };
    }
  }
  if (result.ok) purchaseCache.set(sessionId, { result, until: Date.now() + CACHE_MS });
  return result;
}

// Finds a valid film purchase for an e-mail (used to re-send the watch link).
// Stripe matches e-mails exactly, so both the typed and the lower-cased form are tried.
export async function findFilmPurchaseByEmail(email, typed = email) {
  if (isLegacyBuyer(email)) return { sessionId: legacySessionId(email), email };

  const seen = new Set();
  for (const variant of new Set([typed, email])) {
    const sessions = await stripe().checkout.sessions.list({
      customer_details: { email: variant },
      status: 'complete',
      limit: 100,
    });
    for (const session of sessions.data || []) {
      if (seen.has(session.id) || !isFilmSession(session) || !isPaidSession(session)) continue;
      seen.add(session.id);
      const check = await checkFilmPurchase(session.id);
      if (check.ok) return { sessionId: session.id, email: session.customer_details?.email || email };
    }
  }
  return null;
}
