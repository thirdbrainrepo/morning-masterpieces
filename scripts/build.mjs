#!/usr/bin/env node
// Build pipeline for Morning Masterpieces.
//
// For every seed in data/seeds.mjs:
//   1. Resolve the source (Met / AIC / Wikimedia Commons), enforcing the
//      museum's own public-domain flag where the API provides one.
//   2. Download the original image once into .cache/originals/ (gitignored).
//   3. Compose the derived variants via scripts/process_image.py:
//        site/images/wall/<slug>.jpg      1640x2360 portrait lock-screen wallpaper
//        site/images/wall-ipad/<slug>.jpg 2388x2388 square, safe for both iPad orientations
//        site/images/display/<slug>.jpg   <=1600px display image for the PWA
//   4. Emit site/artworks.json in seed order (chronological survey arc).
//
// Usage: node scripts/build.mjs [--force] [--verify-only]

import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seeds } from '../data/seeds.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'originals');
const SITE = path.join(ROOT, 'site');
const PROCESS = path.join(ROOT, 'scripts', 'process_image.py');
const UA = 'MorningMasterpieces/1.0 (personal art-education project; prharrison@gmail.com)';
const FORCE = process.argv.includes('--force');
const VERIFY_ONLY = process.argv.includes('--verify-only');

const AIC_WIDTHS = [3000, 2400, 1686, 843];
const COMMONS_WIDTHS = [2200, 1600, 1200];

// `python3` on PATH may be a pyenv shim without Pillow; probe for one that
// can actually import PIL. Override with PYTHON=/path/to/python3.
let PYTHON;
async function detectPython() {
  const candidates = [
    process.env.PYTHON,
    'python3',
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      await run(p, ['-c', 'import PIL']);
      return p;
    } catch { /* try next */ }
  }
  throw new Error('No python3 with Pillow found. Install with: pip3 install Pillow');
}

async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        ...opts,
        headers: { 'user-agent': UA, ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(opts.timeout ?? 60_000),
      });
      if (res.status === 429 || res.status >= 500) {
        // Respect Retry-After on rate limits; otherwise back off hard.
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 4000 * (i + 1))));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function getJSON(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function resolveMet(seed) {
  const o = await getJSON(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${seed.id}`);
  if (!o.isPublicDomain) throw new Error(`Met flags object ${seed.id} as NOT public domain`);
  if (!o.primaryImage) throw new Error(`Met object ${seed.id} has no primaryImage`);
  return {
    fetchedTitle: o.title,
    fetchedArtist: o.artistDisplayName,
    imageUrl: o.primaryImage,
    objectUrl: o.objectURL,
    license: 'CC0 — The Met Open Access',
  };
}

async function resolveAic(seed) {
  const { data } = await getJSON(
    `https://api.artic.edu/api/v1/artworks/${seed.id}?fields=id,title,artist_display,date_display,is_public_domain,image_id`
  );
  if (!data.is_public_domain) throw new Error(`AIC flags artwork ${seed.id} as NOT public domain`);
  if (!data.image_id) throw new Error(`AIC artwork ${seed.id} has no image_id`);
  for (const w of AIC_WIDTHS) {
    const url = `https://www.artic.edu/iiif/2/${data.image_id}/full/${w},/0/default.jpg`;
    const res = await fetchWithRetry(url, { method: 'HEAD' }, 2).catch(() => null);
    if (res?.ok) {
      return {
        fetchedTitle: data.title,
        fetchedArtist: data.artist_display,
        imageUrl: url,
        objectUrl: `https://www.artic.edu/artworks/${data.id}`,
        license: 'CC0 — Art Institute of Chicago',
      };
    }
  }
  throw new Error(`no working IIIF size for AIC artwork ${seed.id}`);
}

async function resolveCommons(seed) {
  for (const w of COMMONS_WIDTHS) {
    const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(seed.file)}?width=${w}`;
    const res = await fetchWithRetry(url, { method: 'HEAD' }, 4).catch(() => null);
    if (res?.ok) {
      return {
        fetchedTitle: seed.file,
        fetchedArtist: seed.artist,
        imageUrl: url,
        objectUrl: seed.objectUrl ?? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(seed.file)}`,
        license: 'Public domain — via Wikimedia Commons',
      };
    }
  }
  throw new Error(`Commons file not found: ${seed.file}`);
}

const RESOLVERS = { met: resolveMet, aic: resolveAic, commons: resolveCommons };

function norm(s) {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function download(url, dest) {
  if (existsSync(dest) && !FORCE) return 'cached';
  const res = await fetchWithRetry(url, { timeout: 300_000 });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return 'downloaded';
}

async function processImages(seed, original) {
  const wall = path.join(SITE, 'images', 'wall', `${seed.slug}.jpg`);
  const wallIpad = path.join(SITE, 'images', 'wall-ipad', `${seed.slug}.jpg`);
  const display = path.join(SITE, 'images', 'display', `${seed.slug}.jpg`);
  if (existsSync(wall) && existsSync(wallIpad) && existsSync(display) && !FORCE) return 'cached';
  await run(PYTHON, [
    PROCESS, original, SITE, seed.slug,
    '--title', seed.title, '--artist', seed.artist, '--year', seed.year,
  ]);
  return 'processed';
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(path.join(SITE, 'images', 'wall'), { recursive: true });
  await mkdir(path.join(SITE, 'images', 'wall-ipad'), { recursive: true });
  await mkdir(path.join(SITE, 'images', 'display'), { recursive: true });
  await mkdir(path.join(SITE, 'icons'), { recursive: true });
  if (!VERIFY_ONLY) PYTHON = await detectPython();

  const processSeed = async (seed) => {
    try {
      const resolved = await RESOLVERS[seed.source](seed);
      // Sanity check: the fetched record must actually be the work we expect.
      const hay = norm(`${resolved.fetchedTitle} ${resolved.fetchedArtist}`);
      const mismatch = seed.expect && !norm(seed.expect).split('|').some((e) => hay.includes(e));
      if (mismatch) {
        throw new Error(`EXPECT MISMATCH: wanted "${seed.expect}", API returned "${resolved.fetchedTitle}" by "${resolved.fetchedArtist}"`);
      }
      if (VERIFY_ONLY) return { seed, resolved, status: 'verified' };
      const original = path.join(CACHE, `${seed.slug}.jpg`);
      const dl = await download(resolved.imageUrl, original);
      const proc = await processImages(seed, original);
      return { seed, resolved, status: `${dl}/${proc}` };
    } catch (err) {
      return { seed, error: err.message ?? String(err) };
    }
  };

  // Museum APIs tolerate mild concurrency; Wikimedia's thumbnailer rate-limits
  // aggressively, so Commons goes one at a time with a courtesy pause.
  const museumSeeds = seeds.filter((s) => s.source !== 'commons');
  const commonsSeeds = seeds.filter((s) => s.source === 'commons');
  const [museumResults, commonsResults] = await Promise.all([
    mapLimit(museumSeeds, 4, processSeed),
    mapLimit(commonsSeeds, 1, async (seed) => {
      const r = await processSeed(seed);
      await new Promise((res) => setTimeout(res, 1200));
      return r;
    }),
  ]);
  const bySlug = new Map(
    [...museumResults, ...commonsResults].map((r) => [r.seed.slug, r])
  );
  const results = seeds.map((s) => bySlug.get(s.slug));

  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  for (const r of results) {
    const tag = r.error ? 'FAIL' : ' ok ';
    const detail = r.error ?? `${r.status}  <- "${(r.resolved.fetchedTitle ?? '').slice(0, 60)}"`;
    console.log(`[${tag}] ${r.seed.slug.padEnd(34)} ${r.seed.source.padEnd(8)} ${detail}`);
  }
  console.log(`\n${ok.length}/${seeds.length} resolved${failed.length ? `, ${failed.length} FAILED` : ''}`);

  if (VERIFY_ONLY) return;

  // App icon: a square detail cut from the Great Wave.
  const iconSource = path.join(CACHE, 'hokusai-great-wave.jpg');
  if (existsSync(iconSource)) {
    await run(PYTHON, [PROCESS, iconSource, SITE, 'icon', '--icon']);
  }

  const items = ok.map(({ seed, resolved }) => ({
    slug: seed.slug,
    title: seed.title,
    artist: seed.artist,
    artistDates: seed.artistDates,
    year: seed.year,
    medium: seed.medium,
    movement: seed.movement,
    museum: seed.museum,
    objectUrl: resolved.objectUrl,
    license: resolved.license,
    image: `images/display/${seed.slug}.jpg`,
    wallpaper: `images/wall/${seed.slug}.jpg`,
    wallpaperIpad: `images/wall-ipad/${seed.slug}.jpg`,
    lesson: seed.lesson.trim(),
    lookFor: seed.lookFor.trim(),
  }));

  const manifest = { version: 1, anchor: '2026-01-01', count: items.length, items };
  await writeFile(path.join(SITE, 'artworks.json'), JSON.stringify(manifest, null, 1));
  console.log(`wrote site/artworks.json (${items.length} artworks)`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
