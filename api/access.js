import { DONATION, siteUrl } from '../lib/config.js';
import { HttpError, clientIp, handle, json, rateLimit } from '../lib/http.js';
import { checkFilmPurchase, isFilmSession, isPaidSession, stripe } from '../lib/stripe.js';
import { createAccessToken } from '../lib/token.js';

// GET /api/access?session_id=cs_...
// Called by the thank-you page right after Stripe redirects back. Confirms the
// payment with Stripe and hands out the buyer's personal access token.
export const GET = handle(async (request) => {
  rateLimit(`access:${clientIp(request)}`, 60, 10 * 60 * 1000);
  const sessionId = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,}$/.test(sessionId)) {
    throw new HttpError(400, 'invalid_session', 'Missing or invalid checkout session.');
  }

  let session;
  try {
    session = await stripe().checkout.sessions.retrieve(sessionId);
  } catch (error) {
    if (error?.statusCode === 404 || error?.code === 'resource_missing') {
      throw new HttpError(404, 'not_found', 'Checkout session not found.');
    }
    throw error;
  }

  if (session.metadata?.item === DONATION.id) {
    return json(200, {
      type: 'donation',
      status: isPaidSession(session) ? 'paid' : 'pending',
      amount: session.amount_total,
      currency: session.currency,
    });
  }

  if (!isFilmSession(session)) throw new HttpError(404, 'not_found', 'Checkout session not found.');
  if (!isPaidSession(session)) return json(200, { type: 'film', status: 'pending' });

  const check = await checkFilmPurchase(session.id);
  if (!check.ok) return json(200, { type: 'film', status: check.reason });

  const token = createAccessToken({ email: check.email, sessionId: session.id });
  return json(200, {
    type: 'film',
    status: 'paid',
    email: check.email,
    token,
    watchUrl: `${siteUrl(request)}/watch?t=${encodeURIComponent(token)}`,
  });
});
