import nodemailer from 'nodemailer';
import { FILM, SUPPORT_EMAIL, env } from './config.js';

let transport = null;
let override = null;

export function mailConfigured() {
  return Boolean(override || (env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS')));
}

function transporter() {
  if (override) return override;
  if (!transport) {
    const port = Number.parseInt(env('SMTP_PORT', '465'), 10);
    transport = nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port,
      secure: port === 465,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    });
  }
  return transport;
}

export function setMailTransport(fake) {
  override = fake;
}

function from() {
  return env('MAIL_FROM') || `Fixer Premiere <${env('SMTP_USER')}>`;
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function sendAccessEmail(to, watchUrl) {
  const text = [
    `Thank you for supporting independent cinema!`,
    ``,
    `Your personal link to watch "${FILM.title}":`,
    watchUrl,
    ``,
    `Keep this e-mail — the link works on any device. Please don't share it.`,
    `Questions? Write to ${SUPPORT_EMAIL}.`,
    ``,
    `Fixer Premiere`,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#0b0b0c;font-family:Arial,Helvetica,sans-serif;color:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0c;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#151517;border-radius:16px;padding:32px">
<tr><td style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:#FFFD01;font-weight:700">Fixer Premiere</td></tr>
<tr><td style="padding-top:16px;font-size:24px;font-weight:700;color:#ffffff">Your ticket to “${escapeHtml(FILM.title)}”</td></tr>
<tr><td style="padding-top:12px;font-size:15px;line-height:1.6;color:#c9c9cf">Thank you for supporting independent cinema. The button below opens the film on any device.</td></tr>
<tr><td style="padding-top:24px"><a href="${escapeHtml(watchUrl)}" style="display:inline-block;background:#FFFD01;color:#0b0b0c;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:999px">Watch now</a></td></tr>
<tr><td style="padding-top:24px;font-size:12px;line-height:1.6;color:#8b8b94">Keep this e-mail and don't share the link — it is your personal access.<br>Questions? <a href="mailto:${SUPPORT_EMAIL}" style="color:#FFFD01">${SUPPORT_EMAIL}</a></td></tr>
</table></td></tr></table></body></html>`;

  await transporter().sendMail({
    from: from(),
    to,
    subject: `Your access to “${FILM.title}” — Fixer Premiere`,
    text,
    html,
  });
}

export async function sendNotification({ subject, text, replyTo }) {
  const to = env('NOTIFY_EMAIL') || SUPPORT_EMAIL;
  await transporter().sendMail({ from: from(), to, subject, text, replyTo });
}
