import { FILM } from '../lib/config.js';
import { HttpError, clientIp, handle, json, rateLimit } from '../lib/http.js';
import { filmSource } from '../lib/film.js';
import { checkFilmPurchase } from '../lib/stripe.js';
import { verifyAccessToken } from '../lib/token.js';

// GET /api/film   Authorization: Bearer <access token>
// Verifies the token signature, re-checks the purchase with Stripe (refunds and
// disputes revoke access) and only then reveals a short-lived stream URL.
export const GET = handle(async (request) => {
  rateLimit(`film:${clientIp(request)}`, 60, 10 * 60 * 1000);
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const payload = verifyAccessToken(token);
  if (!payload) throw new HttpError(401, 'invalid_token', 'This watch link is not valid.');

  const check = await checkFilmPurchase(payload.sid);
  if (!check.ok) {
    const message =
      check.reason === 'refunded'
        ? 'This purchase was refunded, so access has ended.'
        : 'We could not confirm this purchase.';
    throw new HttpError(403, `access_${check.reason}`, message);
  }

  const source = await filmSource();
  return json(200, { title: FILM.title, email: check.email, source });
});
