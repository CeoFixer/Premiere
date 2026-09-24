import { env } from '../lib/config.js';
import { json } from '../lib/http.js';
import { mailConfigured } from '../lib/mail.js';

// GET /api/health — shows which integrations are configured (never their values).
export function GET() {
  return json(200, {
    ok: true,
    stripe: Boolean(env('STRIPE_SECRET_KEY')),
    stripeMode: env('STRIPE_SECRET_KEY').startsWith('sk_live_') ? 'live' : env('STRIPE_SECRET_KEY') ? 'test' : 'none',
    webhook: Boolean(env('STRIPE_WEBHOOK_SECRET')),
    accessTokens: env('ACCESS_TOKEN_SECRET').length >= 32,
    mail: mailConfigured(),
    film: env('FILM_S3_BUCKET') && env('FILM_S3_KEY') ? 's3' : env('FILM_EMBED_URL') ? 'embed' : 'none',
    siteUrl: env('SITE_URL') || null,
  });
}
