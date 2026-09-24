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

// Manual block list for a leaked link: REVOKED_ACCESS takes checkout session
// ids (cs_...) and/or buyer e-mails, comma-separated.
function isRevoked(sessionId, email) {
  const revoked = list('REVOKED_ACCESS').map((item) => item.toLowerCase());
  if (!revoked.length) return false;
  return revoked.includes(sessionId.toLowerCase()) || Boolean(email && revoked.includes(email.toLowerCase()));
}

// A chargeback closes access, unless every dispute on the charge ended in our favour.
const CLOSED_IN_OUR_FAVOUR = new Set(['won', 'warning_closed', 'prevented']);

async function disputeLost(charge) {
  const disputes = await stripe().disputes.list({ charge: charge.id, limit: 10 });
  const items = disputes.data || [];
  return !items.length || !items.every((d) => CLOSED_IN_OUR_FAVOUR.has(d.status));
}

// Checks that a purchase is still valid (paid, not refunded, not disputed).
export async function checkFilmPurchase(sessionId) {
  if (sessionId.startsWith(LEGACY_PREFIX)) {
    const email = sessionId.slice(LEGACY_PREFIX.length);
    return isLegacyBuyer(email) && !isRevoked(sessionId, email) ? { ok: true, email } : { ok: false, reason: 'revoked' };
  }
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,}$/.test(sessionId)) return { ok: false, reason: 'not_found' };
  if (isRevoked(sessionId)) return { ok: false, reason: 'revoked' };

  const cached = purchaseCache.get(sessionId);
  if (cached && cached.until > Date.now()) {
    return isRevoked(sessionId, cached.result.email) ? { ok: false, reason: 'revoked' } : cached.result;
  }

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
    // A partial refund keeps access; a full refund or a lost chargeback ends it.
    const charge = session.payment_intent?.latest_charge;
    const email = session.customer_details?.email || '';
    if (charge && typeof charge === 'object' && (charge.refunded || (charge.disputed && (await disputeLost(charge))))) {
      result = { ok: false, reason: 'refunded' };
    } else if (isRevoked(sessionId, email)) {
      result = { ok: false, reason: 'revoked' };
    } else {
      result = { ok: true, email };
    }
  }
  if (result.ok) purchaseCache.set(sessionId, { result, until: Date.now() + CACHE_MS });
  return result;
}

const SCAN_PAGES = 5;

// After a film purchase the lower-cased buyer e-mail is saved on the
// PaymentIntent, so "Restore access" can find it regardless of letter case.
export async function tagBuyerEmail(session) {
  const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  const email = session.customer_details?.email;
  if (!intent || !email) return;
  await stripe().paymentIntents.update(intent, { metadata: { item: FILM.id, buyer_email: email.toLowerCase() } });
}

// Finds a valid film purchase for an e-mail (used to re-send the watch link).
// Order: Stripe's exact e-mail filter (typed and lower-cased forms), then the
// lower-cased e-mail saved on PaymentIntents, then a scan of recent sessions
// as a last resort (e.g. "John@…" at checkout, "john@…" now, no webhook yet).
export async function findFilmPurchaseByEmail(email, typed = email) {
  if (isLegacyBuyer(email)) {
    return isRevoked(legacySessionId(email), email) ? null : { sessionId: legacySessionId(email), email };
  }

  const seen = new Set();
  const consider = async (session) => {
    if (seen.has(session.id) || !isFilmSession(session) || !isPaidSession(session)) return null;
    seen.add(session.id);
    const check = await checkFilmPurchase(session.id);
    return check.ok ? { sessionId: session.id, email: session.customer_details?.email || email } : null;
  };

  for (const variant of new Set([typed, email])) {
    const sessions = await stripe().checkout.sessions.list({
      customer_details: { email: variant },
      status: 'complete',
      limit: 100,
    });
    for (const session of sessions.data || []) {
      const found = await consider(session);
      if (found) return found;
    }
  }

  if (!/['\\]/.test(email)) {
    const intents = await stripe().paymentIntents.search({
      query: `metadata['buyer_email']:'${email}' AND status:'succeeded'`,
      limit: 20,
    });
    for (const intent of intents.data || []) {
      const sessions = await stripe().checkout.sessions.list({ payment_intent: intent.id, limit: 1 });
      for (const session of sessions.data || []) {
        const found = await consider(session);
        if (found) return found;
      }
    }
  }

  let startingAfter;
  for (let page = 0; page < SCAN_PAGES; page += 1) {
    const sessions = await stripe().checkout.sessions.list({
      status: 'complete',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = sessions.data || [];
    for (const session of data) {
      if ((session.customer_details?.email || '').toLowerCase() !== email) continue;
      const found = await consider(session);
      if (found) return found;
    }
    if (!sessions.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }
  return null;
}
