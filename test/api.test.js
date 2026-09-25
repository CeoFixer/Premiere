import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GET as access } from '../api/access.js';
import { POST as checkout } from '../api/checkout.js';
import { POST as contact } from '../api/contact.js';
import { GET as film } from '../api/film.js';
import { POST as restore } from '../api/restore.js';
import { POST as webhook } from '../api/stripe-webhook.js';
import { embedUrl } from '../lib/film.js';
import { createAccessToken, verifyAccessToken } from '../lib/token.js';
import { SITE, WEBHOOK_SECRET, call, fakeMail, fakeStripe, noMail, request, setupEnv } from './helpers.js';

const PAID_ID = 'cs_test_paid0000000001';

describe('checkout', () => {
  let stripe;
  beforeEach(() => {
    setupEnv();
    stripe = fakeStripe();
  });

  it('creates a film checkout with the server-side price', async () => {
    const res = await call(
      checkout,
      request('/api/checkout', { method: 'POST', body: { item: 'film', amount: 1 }, headers: { origin: SITE } }),
    );
    assert.equal(res.status, 200);
    assert.match(res.data.url, /^https:\/\/checkout\.stripe\.com\//);
    const params = stripe.created[0];
    assert.equal(params.line_items[0].price_data.unit_amount, 700);
    assert.equal(params.metadata.item, 'la-plage');
    assert.equal(params.success_url, `${SITE}/thank-you?session_id={CHECKOUT_SESSION_ID}`);
  });

  it('uses a configured Stripe Price when set', async () => {
    process.env.STRIPE_FILM_PRICE_ID = 'price_123';
    await call(checkout, request('/api/checkout', { method: 'POST', body: { item: 'film' } }));
    assert.deepEqual(stripe.created[0].line_items[0], { price: 'price_123', quantity: 1 });
  });

  it('rejects requests from other websites', async () => {
    const res = await call(
      checkout,
      request('/api/checkout', { method: 'POST', body: { item: 'film' }, headers: { origin: 'https://evil.example' } }),
    );
    assert.equal(res.status, 403);
    assert.equal(stripe.created.length, 0);
  });

  it('validates donation amounts', async () => {
    for (const amount of [50, 100001, 12.5, '1000', null]) {
      const res = await call(checkout, request('/api/checkout', { method: 'POST', body: { item: 'donation', amount } }));
      assert.equal(res.status, 400, `amount ${amount}`);
    }
    const ok = await call(checkout, request('/api/checkout', { method: 'POST', body: { item: 'donation', amount: 1500 } }));
    assert.equal(ok.status, 200);
    assert.equal(stripe.created[0].line_items[0].price_data.unit_amount, 1500);
    assert.equal(stripe.created[0].submit_type, 'donate');
    assert.equal(stripe.created[0].customer_email, undefined);
  });

  it('passes the donor e-mail and name to Stripe', async () => {
    const bad = await call(checkout, request('/api/checkout', { method: 'POST', body: { item: 'donation', amount: 1500, email: 'nope' } }));
    assert.equal(bad.status, 400);
    const ok = await call(
      checkout,
      request('/api/checkout', { method: 'POST', body: { item: 'donation', amount: 1500, email: ' Fan@Example.com ', name: 'Ann Lee' } }),
    );
    assert.equal(ok.status, 200);
    const params = stripe.created.at(-1);
    assert.equal(params.customer_email, 'fan@example.com');
    assert.equal(params.metadata.donor_name, 'Ann Lee');
  });

  it('rejects unknown items and non-JSON bodies', async () => {
    const unknown = await call(checkout, request('/api/checkout', { method: 'POST', body: { item: 'free-film' } }));
    assert.equal(unknown.status, 400);
    const raw = await call(
      checkout,
      request('/api/checkout', { method: 'POST', body: 'item=film', raw: true, headers: { 'content-type': 'text/plain' } }),
    );
    assert.equal(raw.status, 415);
  });

  it('answers 503 (not 500) when Stripe is not configured', async () => {
    const { setStripeClient } = await import('../lib/stripe.js');
    setStripeClient(null);
    delete process.env.STRIPE_SECRET_KEY;
    const res = await call(checkout, request('/api/checkout', { method: 'POST', body: { item: 'film' } }));
    assert.equal(res.status, 503);
  });
});

describe('access after payment', () => {
  let stripe;
  beforeEach(() => {
    setupEnv();
    stripe = fakeStripe();
  });

  it('returns a signed token for a paid film session', async () => {
    stripe.addSession({ id: PAID_ID });
    const res = await call(access, request(`/api/access?session_id=${PAID_ID}`));
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'paid');
    assert.equal(res.data.email, 'buyer@example.com');
    assert.equal(verifyAccessToken(res.data.token).sid, PAID_ID);
    assert.ok(res.data.watchUrl.startsWith(`${SITE}/watch?t=`));
  });

  it('does not hand out tokens for unpaid or foreign sessions', async () => {
    stripe.addSession({ id: 'cs_test_unpaid00000001', payment_status: 'unpaid', status: 'open' });
    stripe.addSession({ id: 'cs_test_other000000001', metadata: {} });
    const unpaid = await call(access, request('/api/access?session_id=cs_test_unpaid00000001'));
    assert.equal(unpaid.data.status, 'pending');
    assert.equal(unpaid.data.token, undefined);
    const other = await call(access, request('/api/access?session_id=cs_test_other000000001'));
    assert.equal(other.status, 404);
    const missing = await call(access, request('/api/access?session_id=cs_test_missing0000001'));
    assert.equal(missing.status, 404);
    const invalid = await call(access, request('/api/access?session_id=../../etc'));
    assert.equal(invalid.status, 400);
  });

  it('reports donations without a token', async () => {
    stripe.addSession({ id: 'cs_test_donation000001', metadata: { item: 'donation' }, amount_total: 1500 });
    const res = await call(access, request('/api/access?session_id=cs_test_donation000001'));
    assert.deepEqual(res.data, { type: 'donation', status: 'paid', amount: 1500, currency: 'usd' });
  });
});

describe('film stream', () => {
  let stripe;
  beforeEach(() => {
    setupEnv();
    stripe = fakeStripe();
  });

  const withToken = (token) => request('/api/film', { headers: { authorization: `Bearer ${token}` } });

  it('turns any Vimeo link into the player URL', () => {
    assert.equal(embedUrl('https://vimeo.com/123456789'), 'https://player.vimeo.com/video/123456789');
    assert.equal(embedUrl('https://vimeo.com/123456789/abcdef1234'), 'https://player.vimeo.com/video/123456789?h=abcdef1234');
    assert.equal(embedUrl('https://player.vimeo.com/video/1?h=2'), 'https://player.vimeo.com/video/1?h=2');
    assert.equal(embedUrl('https://iframe.mediadelivery.net/embed/1/2'), 'https://iframe.mediadelivery.net/embed/1/2');
  });

  it('requires a valid signed token', async () => {
    stripe.addSession({ id: PAID_ID });
    assert.equal((await call(film, request('/api/film'))).status, 401);
    const token = createAccessToken({ email: 'buyer@example.com', sessionId: PAID_ID });
    const [body, sig] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ v: 1, sid: 'cs_test_someoneelse0001', sub: 'x' })).toString('base64url');
    assert.equal((await call(film, withToken(`${forgedBody}.${sig}`))).status, 401);
    assert.equal((await call(film, withToken(`${body}.${sig.slice(0, -2)}xx`))).status, 401);
  });

  it('streams for a paid purchase', async () => {
    stripe.addSession({ id: PAID_ID });
    const token = createAccessToken({ email: 'buyer@example.com', sessionId: PAID_ID });
    const res = await call(film, withToken(token));
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.source, { kind: 'embed', src: 'https://player.example/film' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('revokes access after a refund or dispute', async () => {
    stripe.addSession({
      id: 'cs_test_refunded000001',
      payment_intent: { id: 'pi_2', latest_charge: { id: 'ch_2', refunded: true, disputed: false } },
    });
    stripe.addSession({
      id: 'cs_test_disputed000001',
      payment_intent: { id: 'pi_3', latest_charge: { id: 'ch_3', refunded: false, disputed: true } },
    });
    for (const sid of ['cs_test_refunded000001', 'cs_test_disputed000001']) {
      const res = await call(film, withToken(createAccessToken({ email: 'b@example.com', sessionId: sid })));
      assert.equal(res.status, 403);
      assert.equal(res.data.error, 'access_refunded');
    }
  });

  it('keeps access for buyers from the old Wix site', async () => {
    const token = createAccessToken({ email: 'old.buyer@example.com', sessionId: 'legacy:old.buyer@example.com' });
    assert.equal((await call(film, withToken(token))).status, 200);
    process.env.LEGACY_BUYER_EMAILS = '';
    assert.equal((await call(film, withToken(token))).status, 403);
  });

  it('reports "none" when the film file is not configured yet', async () => {
    delete process.env.FILM_EMBED_URL;
    stripe.addSession({ id: PAID_ID });
    const res = await call(film, withToken(createAccessToken({ email: 'buyer@example.com', sessionId: PAID_ID })));
    assert.deepEqual(res.data.source, { kind: 'none' });
  });

  it('signs private S3/R2 links when a bucket is configured', async () => {
    Object.assign(process.env, {
      FILM_S3_BUCKET: 'premiere-films',
      FILM_S3_KEY: 'la-plage.mp4',
      FILM_S3_REGION: 'us-east-1',
      FILM_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      FILM_S3_SECRET_ACCESS_KEY: 'secretexample',
    });
    stripe.addSession({ id: PAID_ID });
    const res = await call(film, withToken(createAccessToken({ email: 'buyer@example.com', sessionId: PAID_ID })));
    assert.equal(res.data.source.kind, 'video');
    const url = new URL(res.data.source.src);
    assert.match(url.hostname, /premiere-films/);
    assert.ok(url.searchParams.get('X-Amz-Signature'));
    assert.equal(url.searchParams.get('X-Amz-Expires'), '21600');
  });
});

describe('restore access by e-mail', () => {
  let stripe;
  let sent;
  beforeEach(() => {
    setupEnv();
    stripe = fakeStripe();
    sent = fakeMail();
  });

  it('e-mails a new link only to a real buyer, with the same answer either way', async () => {
    stripe.addSession({ id: PAID_ID, customer_details: { email: 'Buyer@Example.com' } });
    const found = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'Buyer@Example.com ' } }));
    const unknown = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'nobody@example.com' } }));
    assert.equal(found.status, 200);
    assert.deepEqual(found.data, unknown.data);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'Buyer@Example.com');
    assert.match(sent[0].text, /https:\/\/premiere\.test\/watch\?t=/);
  });

  it('works for legacy buyers', async () => {
    await call(restore, request('/api/restore', { method: 'POST', body: { email: 'OLD.buyer@example.com' } }));
    assert.equal(sent.length, 1);
    const token = decodeURIComponent(/watch\?t=([^\s]+)/.exec(sent[0].text)[1]);
    assert.equal(verifyAccessToken(token).sid, 'legacy:old.buyer@example.com');
  });

  it('skips refunded purchases', async () => {
    stripe.addSession({
      id: 'cs_test_refunded000002',
      payment_intent: { id: 'pi_4', latest_charge: { id: 'ch_4', refunded: true } },
    });
    await call(restore, request('/api/restore', { method: 'POST', body: { email: 'buyer@example.com' } }));
    assert.equal(sent.length, 0);
  });

  it('validates e-mails and rate-limits', async () => {
    const bad = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'not-an-email' } }));
    assert.equal(bad.status, 400);
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await call(restore, request('/api/restore', { method: 'POST', body: { email: `u${i}@example.com` } }));
      statuses.push(res.status);
    }
    assert.equal(statuses.at(-1), 429);
  });

  it('says so when e-mail is not configured', async () => {
    noMail();
    const res = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'buyer@example.com' } }));
    assert.equal(res.status, 503);
  });
});

describe('stripe webhook', () => {
  let stripe;
  let sent;
  beforeEach(() => {
    setupEnv();
    stripe = fakeStripe();
    sent = fakeMail();
  });

  const signed = (event) => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    return request('/api/stripe-webhook', {
      method: 'POST',
      body: payload,
      raw: true,
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    });
  };

  it('rejects unsigned or tampered events', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
    const res = await call(
      webhook,
      request('/api/stripe-webhook', { method: 'POST', body: payload, raw: true, headers: { 'stripe-signature': 't=1,v1=abc' } }),
    );
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  it('e-mails the watch link after a paid film checkout', async () => {
    const session = stripe.addSession({ id: PAID_ID });
    const res = await call(webhook, signed({ id: 'evt_2', type: 'checkout.session.completed', data: { object: session } }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'buyer@example.com');
    const token = decodeURIComponent(/watch\?t=([^\s]+)/.exec(sent[0].text)[1]);
    assert.equal(verifyAccessToken(token).sid, PAID_ID);
  });

  it('ignores donations and unpaid sessions', async () => {
    const donation = stripe.addSession({ id: 'cs_test_donation000002', metadata: { item: 'donation' } });
    const unpaid = stripe.addSession({ id: 'cs_test_unpaid00000002', payment_status: 'unpaid' });
    await call(webhook, signed({ id: 'evt_3', type: 'checkout.session.completed', data: { object: donation } }));
    await call(webhook, signed({ id: 'evt_4', type: 'checkout.session.completed', data: { object: unpaid } }));
    assert.equal(sent.length, 0);
  });
});

describe('contact forms', () => {
  let sent;
  beforeEach(() => {
    setupEnv();
    sent = fakeMail();
  });

  it('forwards subscriptions and film proposals', async () => {
    const sub = await call(contact, request('/api/contact', { method: 'POST', body: { kind: 'subscribe', email: 'fan@example.com' } }));
    assert.equal(sub.status, 200);
    const proposal = await call(
      contact,
      request('/api/contact', {
        method: 'POST',
        body: { kind: 'film', email: 'dir@example.com', firstName: 'Ann', film: 'My Film', message: 'Hello' },
      }),
    );
    assert.equal(proposal.status, 200);
    assert.equal(sent.length, 2);
    assert.match(sent[1].subject, /My Film/);
    assert.equal(sent[1].replyTo, 'dir@example.com');
  });

  it('drops bot submissions silently and validates fields', async () => {
    const bot = await call(
      contact,
      request('/api/contact', { method: 'POST', body: { kind: 'subscribe', email: 'bot@example.com', website: 'http://spam' } }),
    );
    assert.equal(bot.status, 200);
    assert.equal(sent.length, 0);
    const missing = await call(contact, request('/api/contact', { method: 'POST', body: { kind: 'film', email: 'a@example.com' } }));
    assert.equal(missing.status, 400);
  });
});

describe('fixes from the security review', () => {
  let stripe;
  let sent;
  beforeEach(() => {
    setupEnv();
    stripe = fakeStripe();
    sent = fakeMail();
  });

  const withToken = (token) => request('/api/film', { headers: { authorization: `Bearer ${token}` } });

  it('refuses to build links from the Host header when SITE_URL is missing', async () => {
    delete process.env.SITE_URL;
    stripe.addSession({ id: PAID_ID });
    const forged = new Request('https://attacker.example/api/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'buyer@example.com' }),
    });
    const res = await call(restore, forged);
    assert.equal(res.status, 503);
    assert.equal(sent.length, 0);
    const local = new Request('http://localhost:3000/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: 'film' }),
    });
    assert.equal((await call(checkout, local)).status, 200);
    assert.equal(stripe.created[0].success_url, 'http://localhost:3000/thank-you?session_id={CHECKOUT_SESSION_ID}');
  });

  it('keeps access when a dispute was won, ends it when lost', async () => {
    stripe.addSession({
      id: 'cs_test_disputewon0001',
      payment_intent: { id: 'pi_5', latest_charge: { id: 'ch_won', refunded: false, disputed: true } },
    });
    stripe.addSession({
      id: 'cs_test_disputelost001',
      payment_intent: { id: 'pi_6', latest_charge: { id: 'ch_lost', refunded: false, disputed: true } },
    });
    stripe.disputeData.set('ch_won', [{ id: 'dp_1', status: 'won' }]);
    stripe.disputeData.set('ch_lost', [{ id: 'dp_2', status: 'lost' }]);
    const won = await call(film, withToken(createAccessToken({ email: 'a@example.com', sessionId: 'cs_test_disputewon0001' })));
    const lost = await call(film, withToken(createAccessToken({ email: 'a@example.com', sessionId: 'cs_test_disputelost001' })));
    assert.equal(won.status, 200);
    assert.equal(lost.status, 403);
  });

  it('can revoke a single leaked link by session id or e-mail', async () => {
    stripe.addSession({ id: PAID_ID });
    const token = createAccessToken({ email: 'buyer@example.com', sessionId: PAID_ID });
    process.env.REVOKED_ACCESS = PAID_ID;
    assert.equal((await call(film, withToken(token))).status, 403);
    process.env.REVOKED_ACCESS = 'BUYER@example.com';
    const { setStripeClient } = await import('../lib/stripe.js');
    setStripeClient(stripe); // clears the purchase cache
    assert.equal((await call(film, withToken(token))).status, 403);
  });

  it('finds a buyer whose checkout e-mail had different letter case', async () => {
    stripe.addSession({ id: PAID_ID, customer_details: { email: 'John.Doe@Example.com' } });
    const res = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'john.doe@example.com' } }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'John.Doe@Example.com');
  });

  it('answers the same when sending the e-mail fails', async () => {
    stripe.addSession({ id: PAID_ID });
    const { setMailTransport } = await import('../lib/mail.js');
    setMailTransport({
      async sendMail() {
        throw new Error('SMTP down');
      },
    });
    const buyer = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'buyer@example.com' } }));
    const stranger = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'x@example.com' } }));
    assert.equal(buyer.status, 200);
    assert.deepEqual(buyer.data, stranger.data);
  });

  it('sends one e-mail when Stripe delivers the same event twice', async () => {
    const session = stripe.addSession({ id: PAID_ID });
    const payload = JSON.stringify({ id: 'evt_dup_1', type: 'checkout.session.completed', data: { object: session } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const make = () =>
      request('/api/stripe-webhook', {
        method: 'POST',
        body: payload,
        raw: true,
        headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      });
    assert.equal((await call(webhook, make())).status, 200);
    assert.equal((await call(webhook, make())).status, 200);
    assert.equal(sent.length, 1);
  });
});

describe('second review round', () => {
  let stripe;
  let sent;
  beforeEach(() => {
    setupEnv();
    stripe = fakeStripe();
    sent = fakeMail();
  });

  const withToken = (token) => request('/api/film', { headers: { authorization: `Bearer ${token}` } });

  it('tags the lower-cased buyer e-mail and finds old buyers through it', async () => {
    const session = stripe.addSession({
      id: PAID_ID,
      customer_details: { email: 'Mary.Ann@Example.com' },
      payment_intent: { id: 'pi_tag', latest_charge: { id: 'ch_tag', refunded: false, disputed: false } },
    });
    const payload = JSON.stringify({ id: 'evt_tag_1', type: 'checkout.session.completed', data: { object: session } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    await call(
      webhook,
      request('/api/stripe-webhook', { method: 'POST', body: payload, raw: true, headers: { 'stripe-signature': header } }),
    );
    assert.equal(stripe.intentMetadata.get('pi_tag').buyer_email, 'mary.ann@example.com');
    sent.length = 0;
    stripe.scanEnabled = false; // prove the metadata search alone finds it
    const res = await call(restore, request('/api/restore', { method: 'POST', body: { email: 'mary.ann@example.com' } }));
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  });

  it('keeps access when a dispute was prevented', async () => {
    stripe.addSession({
      id: 'cs_test_prevented00001',
      payment_intent: { id: 'pi_p', latest_charge: { id: 'ch_p', refunded: false, disputed: true } },
    });
    stripe.disputeData.set('ch_p', [{ id: 'dp_p', status: 'prevented' }]);
    const res = await call(film, withToken(createAccessToken({ email: 'a@example.com', sessionId: 'cs_test_prevented00001' })));
    assert.equal(res.status, 200);
  });

  it('applies REVOKED_ACCESS even to a cached purchase', async () => {
    stripe.addSession({ id: PAID_ID });
    const token = createAccessToken({ email: 'buyer@example.com', sessionId: PAID_ID });
    assert.equal((await call(film, withToken(token))).status, 200); // now cached
    process.env.REVOKED_ACCESS = 'buyer@example.com';
    assert.equal((await call(film, withToken(token))).status, 403);
  });

  it('limits IPv6 clients per /64 network', async () => {
    const statuses = [];
    for (let i = 1; i <= 6; i += 1) {
      const res = await call(
        restore,
        request('/api/restore', {
          method: 'POST',
          body: { email: `v6-${i}@example.com` },
          headers: { 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` },
        }),
      );
      statuses.push(res.status);
    }
    assert.equal(statuses.at(-1), 429);
  });

  it('flooding one limiter does not reset another', async () => {
    const { rateLimit } = await import('../lib/http.js');
    for (let i = 0; i < 3; i += 1) rateLimit('restore-email:victim@example.com', 3, 3600000);
    for (let i = 0; i < 60000; i += 1) rateLimit(`film:10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 60, 600000);
    assert.throws(() => rateLimit('restore-email:victim@example.com', 3, 3600000), /Too many requests/);
  });
});
