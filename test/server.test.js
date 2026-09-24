import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let server;
let base;

function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(text));
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('standalone server', () => {
  before(async () => {
    if (!existsSync(`${ROOT}dist/index.html`)) {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, env: { ...process.env, SKIP_MEDIA: '1' } });
    }
    const { createAppServer } = await import('../server.mjs');
    server = createAppServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  const get = (path, headers = {}) => fetch(base + path, { redirect: 'manual', headers });

  it('never redirects to another host', async () => {
    for (const path of ['/.//evil.com/', '/.//evil.com/x.html', '//evil.com/', '/%5C%5Cevil.com/']) {
      const res = await get(path);
      const location = res.headers.get('location');
      if (location) assert.ok(location.startsWith('/') && !/^\/[/\\]/.test(location), `${path} -> ${location}`);
    }
  });

  it('does not let the Host header change the path', async () => {
    const answer = await raw(server.address().port, 'GET /about HTTP/1.1\r\nHost: localhost/api/health#\r\nConnection: close\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 400/);
  });

  it('rejects absolute-form request targets', async () => {
    const answer = await raw(server.address().port, 'GET http://attacker.example/api/health HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 400/);
  });

  it('serves pages, redirects old Wix URLs, returns real 404s', async () => {
    assert.equal((await get('/')).status, 200);
    const old = await get('/laplage');
    assert.equal(old.status, 308);
    assert.equal(old.headers.get('location'), '/la-plage');
    assert.equal((await get('/nope')).status, 404);
    assert.equal((await get('/404')).status, 404);
    assert.equal((await get('/..%2f..%2fpackage.json')).status, 404);
  });

  it('handles byte ranges', async () => {
    assert.equal((await get('/robots.txt', { range: 'bytes=0-9' })).status, 206);
    assert.equal((await get('/robots.txt', { range: 'bytes=5-3' })).status, 200);
    assert.equal((await get('/robots.txt', { range: 'bytes=-' })).status, 200);
    assert.equal((await get('/robots.txt', { range: 'bytes=999999-' })).status, 416);
  });

  it('sends security headers', async () => {
    const res = await get('/');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});
