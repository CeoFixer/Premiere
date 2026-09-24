import { siteUrl } from '../lib/config.js';
import { HttpError, assertSameOrigin, clientIp, handle, json, normalizeEmail, rateLimit, readJson } from '../lib/http.js';
import { mailConfigured, sendAccessEmail } from '../lib/mail.js';
import { findFilmPurchaseByEmail } from '../lib/stripe.js';
import { createAccessToken } from '../lib/token.js';

const GENERIC = 'If this e-mail bought the film, a new watch link is on its way. Check your inbox and spam folder.';

// POST /api/restore  { email }
// Re-sends the personal watch link to the purchase e-mail. The answer is the
// same whether or not a purchase exists, so it can't be used to probe buyers,
// and the link only ever goes to the buyer's own inbox.
export const POST = handle(async (request) => {
  assertSameOrigin(request);
  rateLimit(`restore:${clientIp(request)}`, 5, 15 * 60 * 1000);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const typed = String(body.email).trim();
  rateLimit(`restore-email:${email}`, 3, 60 * 60 * 1000);

  if (!mailConfigured()) {
    throw new HttpError(503, 'mail_unavailable', 'E-mail delivery is not set up yet. Please write to support@fixer-app.com.');
  }

  const purchase = await findFilmPurchaseByEmail(email, typed);
  if (purchase) {
    const token = createAccessToken({ email: purchase.email, sessionId: purchase.sessionId });
    await sendAccessEmail(purchase.email, `${siteUrl(request)}/watch?t=${encodeURIComponent(token)}`);
  }
  return json(200, { ok: true, message: GENERIC });
});
