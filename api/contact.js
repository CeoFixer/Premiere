import { env } from '../lib/config.js';
import {
  HttpError,
  assertSameOrigin,
  cleanText,
  clientIp,
  handle,
  json,
  normalizeEmail,
  rateLimit,
  readJson,
} from '../lib/http.js';
import { mailConfigured, sendNotification } from '../lib/mail.js';

// POST /api/contact
//   { kind: "subscribe", email }                                   — newsletter sign-up
//   { kind: "film", firstName, lastName, email, film, link, message } — filmmaker proposes a film
// Submissions are forwarded to the team by e-mail and, optionally, to
// FORMS_WEBHOOK_URL (Zapier, Make, Google Sheets script...).
export const POST = handle(async (request) => {
  assertSameOrigin(request);
  rateLimit(`contact:${clientIp(request)}`, 8, 15 * 60 * 1000);
  const body = await readJson(request);

  // Honeypot: real visitors never fill the hidden "website" field.
  if (cleanText(body.website, 200)) return json(200, { ok: true });

  const email = normalizeEmail(body.email);
  let record;
  if (body.kind === 'subscribe') {
    record = { kind: 'subscribe', email };
  } else if (body.kind === 'film') {
    record = {
      kind: 'film',
      email,
      firstName: cleanText(body.firstName, 80),
      lastName: cleanText(body.lastName, 80),
      film: cleanText(body.film, 160),
      link: cleanText(body.link, 500),
      message: cleanText(body.message, 4000),
    };
    if (!record.firstName || !record.film) {
      throw new HttpError(400, 'missing_fields', 'Please tell us your name and the film title.');
    }
  } else {
    throw new HttpError(400, 'invalid_kind', 'Unknown form.');
  }

  const webhook = env('FORMS_WEBHOOK_URL');
  if (!webhook && !mailConfigured()) {
    throw new HttpError(503, 'forms_unavailable', 'Forms are not set up yet. Please write to support@fixer-app.com.');
  }

  record.receivedAt = new Date().toISOString();
  const tasks = [];
  if (webhook) {
    tasks.push(
      fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(10000),
      }).then((res) => {
        if (!res.ok) throw new Error(`forms webhook answered ${res.status}`);
      }),
    );
  }
  if (mailConfigured()) {
    const subject =
      record.kind === 'subscribe'
        ? `New subscriber: ${record.email}`
        : `Film proposal: ${record.film} — ${record.firstName} ${record.lastName}`.trim();
    const text = Object.entries(record)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    tasks.push(sendNotification({ subject: subject.replace(/\s+/g, ' ').slice(0, 200), text, replyTo: record.email }));
  }

  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected');
  failed.forEach((r) => console.error('[contact] delivery failed', r.reason));
  if (failed.length === results.length) {
    throw new HttpError(502, 'delivery_failed', 'We could not send your message. Please try again later.');
  }
  return json(200, { ok: true });
});
