import Stripe from 'stripe';
import { resetRateLimits } from '../lib/http.js';
import { setMailTransport } from '../lib/mail.js';
import { setStripeClient } from '../lib/stripe.js';

export const SITE = 'https://premiere.test';
export const WEBHOOK_SECRET = 'whsec_test_secret';

export function setupEnv(extra = {}) {
  const base = {
    SITE_URL: SITE,
    ACCESS_TOKEN_SECRET: 'test-secret-that-is-long-enough-0123456789abcdef',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    FILM_EMBED_URL: 'https://player.example/film',
    FILM_PRICE_CENTS: '700',
    LEGACY_BUYER_EMAILS: 'old.buyer@example.com',
  };
  for (const key of [
    'SITE_URL',
    'ACCESS_TOKEN_SECRET',
    'STRIPE_WEBHOOK_SECRET',
    'FILM_EMBED_URL',
    'FILM_PRICE_CENTS',
    'LEGACY_BUYER_EMAILS',
    'FILM_S3_BUCKET',
    'FILM_S3_KEY',
    'FORMS_WEBHOOK_URL',
    'STRIPE_FILM_PRICE_ID',
    'SMTP_HOST',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, base, extra);
  resetRateLimits();
}

// Minimal in-memory stand-in for the Stripe client.
export function fakeStripe() {
  const sessions = new Map();
  const created = [];
  let counter = 0;
  const client = {
    sessions,
    created,
    addSession(session) {
      const full = {
        object: 'checkout.session',
        mode: 'payment',
        status: 'complete',
        payment_status: 'paid',
        metadata: { item: 'la-plage' },
        customer_details: { email: 'buyer@example.com' },
        payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', refunded: false, disputed: false } },
        amount_total: 700,
        currency: 'usd',
        ...session,
      };
      sessions.set(full.id, full);
      return full;
    },
    checkout: {
      sessions: {
        async create(params) {
          counter += 1;
          const id = `cs_test_created${String(counter).padStart(6, '0')}`;
          created.push(params);
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
        async retrieve(id, options = {}) {
          const session = sessions.get(id);
          if (!session) {
            const error = new Error('No such checkout.session');
            error.statusCode = 404;
            error.code = 'resource_missing';
            throw error;
          }
          const copy = structuredClone(session);
          if (!options.expand?.includes('payment_intent.latest_charge') && copy.payment_intent) {
            copy.payment_intent = copy.payment_intent.id;
          }
          return copy;
        },
        async list(params) {
          const email = params.customer_details?.email;
          const data = [...sessions.values()].filter(
            (s) => s.customer_details?.email === email && (!params.status || s.status === params.status),
          );
          return { data: structuredClone(data) };
        },
      },
    },
    webhooks: new Stripe('sk_test_dummy').webhooks,
  };
  setStripeClient(client);
  return client;
}

export function fakeMail() {
  const sent = [];
  setMailTransport({
    async sendMail(message) {
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  });
  return sent;
}

export function noMail() {
  setMailTransport(null);
  delete process.env.SMTP_HOST;
}

export function request(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!raw) init.headers['content-type'] = 'application/json';
  }
  return new Request(`${SITE}${path}`, init);
}

export async function call(handler, req) {
  const res = await handler(req);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers };
}
