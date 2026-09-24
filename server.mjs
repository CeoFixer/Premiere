// Standalone Node server for any host (VPS, Render, Railway, Fly...).
// Serves the built site from dist/ and the same /api handlers Vercel uses.
// Redirects and security headers come from vercel.json so both stay in sync.
//
//   npm run build && npm start        (PORT defaults to 3000)
//   TRUST_PROXY=1 when running behind nginx/Caddy that sets X-Forwarded-*.

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');
const API_DIR = join(ROOT, 'api');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
const MAX_BODY = 1024 * 1024;

loadDotEnv(join(ROOT, '.env'));

const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const redirects = new Map(config.redirects.map((r) => [r.source, r]));
const headerRules = config.headers.map((rule) => ({
  pattern: new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '.*')}$`),
  headers: Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value])),
}));
const apiNames = new Set(
  readdirSync(API_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3)),
);
const apiModules = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
};

function headersFor(pathname) {
  const out = {};
  for (const rule of headerRules) if (rule.pattern.test(pathname)) Object.assign(out, rule.headers);
  return out;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

async function handleApi(req, res, url) {
  const name = url.pathname.slice('/api/'.length);
  if (!/^[a-z-]+$/.test(name) || !apiNames.has(name)) {
    return send(res, 404, { 'content-type': 'application/json' }, '{"error":"not_found"}');
  }
  if (!apiModules.has(name)) apiModules.set(name, await import(join(API_DIR, `${name}.js`)));
  const mod = apiModules.get(name);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const handler = mod[method];
  if (typeof handler !== 'function') {
    const allow = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => typeof mod[m] === 'function').join(', ');
    return send(res, 405, { allow, 'content-type': 'application/json' }, '{"error":"method_not_allowed"}');
  }

  const chunks = [];
  let size = 0;
  if (!['GET', 'HEAD'].includes(req.method)) {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, 413, { 'content-type': 'application/json' }, '{"error":"payload_too_large"}');
      chunks.push(chunk);
    }
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  if (!TRUST_PROXY) {
    headers.set('x-forwarded-for', req.socket.remoteAddress || 'unknown');
    headers.delete('x-real-ip');
  }

  const request = new Request(url, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await handler(request);
  const outHeaders = { ...headersFor(url.pathname) };
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  const body = req.method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer());
  send(res, response.status, outHeaders, body);
}

function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidates = decoded === '/' ? ['/index.html'] : extname(decoded) ? [decoded] : [`${decoded}.html`, `${decoded}/index.html`];
  for (const candidate of candidates) {
    const file = normalize(join(DIST, candidate));
    if (!file.startsWith(DIST + sep)) return null;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

function serveFile(req, res, file, status, pathname) {
  const stat = statSync(file);
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    ...headersFor(pathname),
    'content-type': type,
    'accept-ranges': 'bytes',
    'last-modified': stat.mtime.toUTCString(),
  };
  if (type.startsWith('text/html')) headers['cache-control'] = 'no-cache';

  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && status === 200) {
    const start = range[1] ? Number(range[1]) : Math.max(stat.size - Number(range[2] || 0), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      return send(res, 416, { ...headers, 'content-range': `bytes */${stat.size}` });
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(status, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function handleStatic(req, res, url) {
  const { pathname } = url;
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { allow: 'GET, HEAD' });

  const redirect = redirects.get(pathname);
  if (redirect) return send(res, redirect.permanent ? 308 : 307, { location: redirect.destination + url.search });
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return send(res, 308, { location: pathname.replace(/\/+$/, '') + url.search });
  }
  if (pathname.endsWith('.html')) {
    const clean = pathname === '/index.html' ? '/' : pathname.slice(0, -5);
    return send(res, 308, { location: clean + url.search });
  }

  const file = resolveFile(pathname);
  if (file) return serveFile(req, res, file, 200, pathname);
  const notFound = join(DIST, '404.html');
  if (existsSync(notFound)) return serveFile(req, res, notFound, 404, pathname);
  send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function createAppServer() {
  return createServer((req, res) => {
    const proto = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() : 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    let url;
    try {
      url = new URL(req.url, `${proto}://${host}`);
    } catch {
      return send(res, 400, { 'content-type': 'text/plain' }, 'Bad request');
    }
    const work = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : Promise.resolve(handleStatic(req, res, url));
    work.catch((error) => {
      console.error('[server]', error);
      if (!res.headersSent) send(res, 500, { 'content-type': 'text/plain' }, 'Internal error');
      else res.destroy();
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('dist/ is missing — run "npm run build" first.');
    process.exit(1);
  }
  createAppServer().listen(PORT, HOST, () => {
    console.log(`Fixer Premiere running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}
