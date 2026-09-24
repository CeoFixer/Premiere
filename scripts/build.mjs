// Builds the static site into dist/:
//  - wraps every site/pages/*.html in site/layout.html (+ header/footer partials)
//  - copies assets and the Inter font, fingerprints CSS/JS with ?v=<hash>
//  - downloads the images listed in site/media.json (cached in .cache/media)
//  - writes robots.txt, sitemap.xml and the web manifest
//
// Env used at build time (all optional):
//   SITE_URL          https://www.fixer-premiere.com (canonical links, sitemap)
//   FILM_PRICE_CENTS  700 → "$7" shown on the pages (the server charges the same env)
//   TRAILER_URL       mp4 or YouTube/Vimeo embed URL for the trailer
//   STRICT_MEDIA=1    fail the build if any image could not be downloaded

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache', 'media');

const SITE_URL = (process.env.SITE_URL || 'https://www.fixer-premiere.com').replace(/\/+$/, '');
const PRICE_CENTS = Number.parseInt(process.env.FILM_PRICE_CENTS || '700', 10) || 700;
const DEFAULT_TRAILER = [
  'https://video.wixstatic.com/video/0d0600_20599729f319491ebdf0d058841a2bc8/1080p/mp4/file.mp4',
  'https://video.wixstatic.com/video/0d0600_20599729f319491ebdf0d058841a2bc8/720p/mp4/file.mp4',
  'https://video.wixstatic.com/video/0d0600_20599729f319491ebdf0d058841a2bc8/480p/mp4/file.mp4',
];
const FONT_FILES = ['latin', 'latin-ext', 'cyrillic'].map((subset) => `inter-${subset}-wght-normal.woff2`);

const escapeAttr = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatUsd(cents) {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function trailer() {
  const custom = (process.env.TRAILER_URL || '').trim();
  if (!custom) return { kind: 'video', sources: DEFAULT_TRAILER };
  const isFile = /\.(mp4|webm|m4v)(\?|$)/i.test(custom);
  return { kind: isFile ? 'video' : 'embed', sources: [custom] };
}

function parsePage(raw, file) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) throw new Error(`${file}: missing front matter`);
  const meta = JSON.parse(match[1]);
  return { meta, body: raw.slice(match[0].length) };
}

function render(template, vars, partials, file) {
  return template.replace(/\{\{\s*([>\w:.-]+(?:\s+[\w-]+)?)\s*\}\}/g, (_, key) => {
    if (key.startsWith('>')) {
      const name = key.slice(1).trim();
      if (!(name in partials)) throw new Error(`${file}: unknown partial ${name}`);
      return render(partials[name], vars, partials, `${file} > ${name}`);
    }
    if (key.startsWith('nav:')) {
      return vars.nav === key.slice(4) ? ' class="is-active" aria-current="page"' : '';
    }
    if (!(key in vars)) throw new Error(`${file}: unknown variable {{${key}}}`);
    return vars[key];
  });
}

async function hashFiles(paths) {
  const hash = createHash('sha1');
  for (const path of paths) hash.update(await readFile(path));
  return hash.digest('hex').slice(0, 10);
}

async function download(url, timeoutMs = 60000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'image/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`unexpected content-type ${type}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchMedia() {
  const manifest = JSON.parse(await readFile(join(SITE, 'media.json'), 'utf8'));
  await mkdir(join(DIST, 'media'), { recursive: true });
  await mkdir(CACHE, { recursive: true });

  const localDir = join(SITE, 'media');
  const local = existsSync(localDir) ? new Set(await readdir(localDir)) : new Set();
  for (const name of local) await copyFile(join(localDir, name), join(DIST, 'media', name));

  const missing = [];
  const queue = manifest.items.filter((item) => !local.has(item.file));
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const cached = join(CACHE, item.file);
      if (!existsSync(cached)) {
        const urls = [];
        if (item.w && item.h) {
          urls.push(`${item.src}/v1/fill/w_${item.w},h_${item.h},al_c,q_85,usm_0.66_1.00_0.01/${item.file}`);
        }
        urls.push(item.src);
        let data = null;
        let lastError = null;
        for (const url of urls) {
          try {
            data = await download(url);
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!data) {
          missing.push(`${item.file} (${lastError?.message || 'failed'})`);
          continue;
        }
        await writeFile(cached, data);
      }
      await copyFile(cached, join(DIST, 'media', item.file));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  if (missing.length) {
    console.warn(`\n[media] ${missing.length} image(s) could not be downloaded:\n  - ${missing.join('\n  - ')}`);
    if (process.env.STRICT_MEDIA === '1') throw new Error('Missing media (STRICT_MEDIA=1)');
  }
  return manifest.items.length - missing.length;
}

async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(join(SITE, 'assets'), join(DIST, 'assets'), { recursive: true });

  const fontSource = join(ROOT, 'node_modules', '@fontsource-variable', 'inter', 'files');
  await mkdir(join(DIST, 'assets', 'fonts'), { recursive: true });
  for (const font of FONT_FILES) await copyFile(join(fontSource, font), join(DIST, 'assets', 'fonts', font));

  const version = await hashFiles([join(SITE, 'assets', 'css', 'site.css'), join(SITE, 'assets', 'js', 'site.js')]);
  const layout = await readFile(join(SITE, 'layout.html'), 'utf8');
  const partials = {};
  for (const file of await readdir(join(SITE, 'partials'))) {
    partials[file.replace(/\.html$/, '')] = await readFile(join(SITE, 'partials', file), 'utf8');
  }

  const trailerConfig = trailer();
  const shared = {
    v: version,
    year: String(new Date().getFullYear()),
    siteUrl: SITE_URL,
    price: formatUsd(PRICE_CENTS),
    priceNumber: (PRICE_CENTS / 100).toFixed(2),
    trailerKind: trailerConfig.kind,
    trailerSources: escapeAttr(JSON.stringify(trailerConfig.sources)),
  };

  const sitemap = [];
  const pageFiles = (await readdir(join(SITE, 'pages'))).filter((f) => f.endsWith('.html')).sort();
  for (const file of pageFiles) {
    const raw = await readFile(join(SITE, 'pages', file), 'utf8');
    const { meta, body } = parsePage(raw, file);
    const slug = file.replace(/\.html$/, '');
    const path = slug === 'index' ? '/' : `/${slug}`;
    const indexable = meta.index !== false;
    const vars = {
      ...shared,
      slug,
      path,
      nav: meta.nav || '',
      title: escapeAttr(meta.title),
      description: escapeAttr(meta.description),
      canonical: `${SITE_URL}${path === '/' ? '' : path}`,
      ogImage: `${SITE_URL}/media/${meta.ogImage || 'og-image.jpg'}`,
      robots: indexable ? 'index, follow' : 'noindex, nofollow',
      head: '',
    };
    vars.content = render(body, vars, partials, file);
    vars.head = meta.head ? render(meta.head.join('\n'), vars, partials, file) : '';
    await writeFile(join(DIST, `${slug}.html`), render(layout, vars, partials, 'layout.html'));
    if (indexable && slug !== '404') sitemap.push({ path, priority: meta.priority || '0.5' });
  }

  const today = new Date().toISOString().slice(0, 10);
  await writeFile(
    join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap
      .map(
        (p) =>
          `  <url><loc>${SITE_URL}${p.path === '/' ? '/' : p.path}</loc><lastmod>${today}</lastmod><priority>${p.priority}</priority></url>`,
      )
      .join('\n')}\n</urlset>\n`,
  );
  await writeFile(
    join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /watch\nDisallow: /thank-you\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
  );
  await writeFile(
    join(DIST, 'site.webmanifest'),
    JSON.stringify(
      {
        name: 'Fixer Premiere',
        short_name: 'Premiere',
        description: 'Independent cinema, premiered online.',
        start_url: '/',
        display: 'standalone',
        background_color: '#0b0b0c',
        theme_color: '#0b0b0c',
        icons: [{ src: '/assets/img/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      null,
      2,
    ),
  );

  const media = await fetchMedia();
  console.log(`Built ${pageFiles.length} pages, ${media} media files → dist/ (assets v${version})`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
