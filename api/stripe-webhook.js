import { requireEnv, siteUrl } from '../lib/config.js';
import { handle, json } from '../lib/http.js';
import { mailConfigured, sendAccessEmail } from '../lib/mail.js';
import { checkFilmPurchase, isFilmSession, isPaidSession, stripe, tagBuyerEmail } from '../lib/stripe.js';
import { createAccessToken } from '../lib/token.js';

const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

// Stripe may deliver an event more than once; remember recent ids (per instance)
// so a buyer doesn't get the same e-mail twice.
const handled = new Map();
const HANDLED_MS = 24 * 60 * 60 * 1000;

function alreadyHandled(id) {
  const now = Date.now();
  if (handled.size > 5000) for (const [key, at] of handled) if (now - at > HANDLED_MS) handled.delete(key);
  return handled.has(id);
}

// POST /api/stripe-webhook — Stripe calls this after a payment.
// The signature is verified with STRIPE_WEBHOOK_SECRET before anything is trusted.
// On a paid film purchase the buyer gets the watch link by e-mail.
export const POST = handle(async (request) => {
  const secret = requireEnv('STRIPE_WEBHOOK_SECRET');
  const signature = request.headers.get('stripe-signature') || '';
  const payload = await request.text();

  let event;
  try {
    event = stripe().webhooks.constructEvent(payload, signature, secret);
  } catch {
    return json(400, { error: 'invalid_signature' });
  }

  if (EVENTS.has(event.type) && !alreadyHandled(event.id)) {
    const session = event.data.object;
    const email = session.customer_details?.email;
    if (isFilmSession(session) && isPaidSession(session) && email) {
      try {
        await tagBuyerEmail(session);
      } catch (error) {
        console.error('[webhook] could not tag buyer e-mail', error?.message || error);
      }
      const check = await checkFilmPurchase(session.id);
      if (check.ok && mailConfigured()) {
        const token = createAccessToken({ email, sessionId: session.id });
        await sendAccessEmail(email, `${siteUrl(request)}/watch?t=${encodeURIComponent(token)}`);
      }
    }
    handled.set(event.id, Date.now());
  }
  return json(200, { received: true });
});
