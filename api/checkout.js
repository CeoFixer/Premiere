import { DONATION, FILM, env, siteUrl } from '../lib/config.js';
import { HttpError, assertSameOrigin, cleanText, clientIp, handle, json, normalizeEmail, rateLimit, readJson } from '../lib/http.js';
import { stripe } from '../lib/stripe.js';

// POST /api/checkout  { item: "film" }  or  { item: "donation", amount: 1000, email?, name? }
// Creates a Stripe Checkout Session and returns its URL. Prices are decided
// here on the server — the browser can only choose what to buy.
export const POST = handle(async (request) => {
  assertSameOrigin(request);
  rateLimit(`checkout:${clientIp(request)}`, 20, 10 * 60 * 1000);
  const body = await readJson(request);
  const site = siteUrl(request);

  let params;
  if (body.item === 'film') {
    const priceId = env('STRIPE_FILM_PRICE_ID');
    params = {
      mode: 'payment',
      line_items: [
        priceId
          ? { price: priceId, quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: FILM.currency,
                unit_amount: FILM.priceCents,
                product_data: {
                  name: `${FILM.title} — feature film`,
                  description: FILM.description,
                  images: [`${site}/media/poster-main.jpg`],
                },
              },
            },
      ],
      metadata: { item: FILM.id },
      payment_intent_data: { metadata: { item: FILM.id }, description: `${FILM.title} — streaming access` },
      customer_creation: 'always',
      allow_promotion_codes: true,
      submit_type: 'pay',
      custom_text: {
        submit: { message: 'Instant access after payment. We also e-mail you a personal watch link.' },
      },
      success_url: `${site}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/la-plage?checkout=cancelled`,
    };
  } else if (body.item === 'donation') {
    const amount = body.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < DONATION.minCents || amount > DONATION.maxCents) {
      throw new HttpError(400, 'invalid_amount', 'Please choose an amount between $1 and $1,000.');
    }
    const email = body.email ? normalizeEmail(body.email) : undefined;
    const name = cleanText(body.name, 100);
    const metadata = name ? { item: DONATION.id, donor_name: name } : { item: DONATION.id };
    params = {
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amount,
            product_data: { name: DONATION.title, description: 'Thank you for supporting independent cinema.' },
          },
        },
      ],
      metadata,
      payment_intent_data: { metadata, description: DONATION.title },
      ...(email && { customer_email: email }),
      submit_type: 'donate',
      success_url: `${site}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/donate?checkout=cancelled`,
    };
  } else {
    throw new HttpError(400, 'invalid_item', 'Unknown item.');
  }

  const session = await stripe().checkout.sessions.create(params);
  return json(200, { url: session.url });
});
