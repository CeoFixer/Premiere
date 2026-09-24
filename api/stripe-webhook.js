import { requireEnv, siteUrl } from '../lib/config.js';
import { handle, json } from '../lib/http.js';
import { mailConfigured, sendAccessEmail } from '../lib/mail.js';
import { checkFilmPurchase, isFilmSession, isPaidSession, stripe } from '../lib/stripe.js';
import { createAccessToken } from '../lib/token.js';

const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

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

  if (EVENTS.has(event.type)) {
    const session = event.data.object;
    const email = session.customer_details?.email;
    if (isFilmSession(session) && isPaidSession(session) && email && mailConfigured()) {
      const check = await checkFilmPurchase(session.id);
      if (check.ok) {
        const token = createAccessToken({ email, sessionId: session.id });
        await sendAccessEmail(email, `${siteUrl(request)}/watch?t=${encodeURIComponent(token)}`);
      }
    }
  }
  return json(200, { received: true });
});
