#!/usr/bin/env node
// Build pipeline for Morning Masterpieces.
//
// For every seed in data/seeds.mjs:
//   1. Resolve the source (Met / AIC / Wikimedia Commons), enforcing the
//      museum's own public-domain flag where the API provides one.
//   2. Download the original image once into .cache/originals/ (gitignored).
//   3. Compose the derived variants via scripts/process_image.py:
//        site/images/wall/<slug>.jpg      1640x2360 portrait lock-screen wallpaper
//        site/images/wall-ipad/<slug>.jpg 2420x2420 square, safe for both iPad orientations
//        site/images/display/<slug>.jpg   <=1600px display image for the PWA
//   4. Emit site/artworks.json in seed order (chronological survey arc).
//
// Usage: node scripts/build.mjs [--force] [--verify-only]

import { mkdir, writeFile, rename } from 'node:fs/promises';
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
// Contact for API etiquette headers. Defaults to the public project URL so
// no personal data ships in the code; set SOURCE_CONTACT to override.
const CONTACT = process.env.SOURCE_CONTACT
  ?? 'https://github.com/thirdbrainrepo/morning-masterpieces';
const UA = `MorningMasterpieces/1.0 (personal art-education project; ${CONTACT})`;
const FORCE = process.argv.includes('--force');
const VERIFY_ONLY = process.argv.includes('--verify-only');

const AIC_WIDTHS = [3000, 2400, 1686, 843];
const COMMONS_WIDTHS = [2200, 1600, 1200];

// `python3` on PATH may be a pyenv shim without Pillow; probe for one that
// can import everything the compositor needs (Pillow AND NumPy — the matte
// dither uses numpy). Override with PYTHON=/path/to/python3.
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
      await run(p, ['-c', 'import PIL, numpy']);
      return p;
    } catch { /* try next */ }
  }
  throw new Error('No python3 with Pillow+NumPy found. Install with: pip3 install Pillow numpy');
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
  // First-party rights check, mirroring the Met/AIC PD flags: the Commons
  // file's own metadata must positively assert the work is out of copyright,
  // and `expect` is checked against the REMOTE title/artist — echoing seed
  // values back (the old behavior) made the identity check tautological.
  const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2'
    + `&prop=imageinfo&iiprop=extmetadata%7Curl&titles=${encodeURIComponent(`File:${seed.file}`)}`;
  const info = (await getJSON(api))?.query?.pages?.[0]?.imageinfo?.[0];
  const meta = info?.extmetadata;
  if (!meta) throw new Error(`Commons has no metadata for ${seed.file} — cannot verify rights`);
  const plain = (f) => (f?.value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const licenseShort = plain(meta.LicenseShortName);
  const copyrighted = plain(meta.Copyrighted).toLowerCase();
  const isPD = copyrighted === 'false' || /public domain|\bpd\b|cc0/i.test(licenseShort);
  if (!isPD) {
    throw new Error(`Commons does NOT flag ${seed.file} as public domain `
      + `(license: "${licenseShort || 'unstated'}", copyrighted: "${copyrighted || 'unstated'}")`);
  }
  for (const w of COMMONS_WIDTHS) {
    const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(seed.file)}?width=${w}`;
    const res = await fetchWithRetry(url, { method: 'HEAD' }, 4).catch(() => null);
    if (res?.ok) {
      return {
        fetchedTitle: plain(meta.ObjectName) || seed.file,
        fetchedArtist: plain(meta.Artist),
        imageUrl: url,
        imageSourceUrl: info.descriptionurl,
        objectUrl: seed.objectUrl ?? info.descriptionurl,
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
  // Originals are immutable — never re-download (even under --force, which
  // only reprocesses variants). Delete .cache/originals/ to truly refetch.
  // Stream to a temp name and rename: existence is the cache check, so an
  // interrupted transfer must never leave a partial file at the final path.
  if (existsSync(dest)) return 'cached';
  const res = await fetchWithRetry(url, { timeout: 300_000 });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dest}.part`));
  await rename(`${dest}.part`, dest);
  return 'downloaded';
}

const VARIANT_DIRS = ['wall', 'wall-ipad', 'home', 'home-ipad', 'zoom', 'display'];

async function processImages(seed, original) {
  const outputs = VARIANT_DIRS.map((d) => path.join(SITE, 'images', d, `${seed.slug}.jpg`));
  if (outputs.every((p) => existsSync(p)) && !FORCE) return 'cached';
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
  for (const d of VARIANT_DIRS) {
    await mkdir(path.join(SITE, 'images', d), { recursive: true });
  }
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

  // Fail closed BEFORE touching the manifest: writing only the successful
  // works would shrink the rotation, remapping every future day — a
  // transient museum outage must never masquerade as a collection change.
  if (failed.length) {
    if (!VERIFY_ONLY) console.error('build FAILED — site/artworks.json left untouched');
    process.exitCode = 1;
    return;
  }

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
    imageSourceUrl: resolved.imageSourceUrl ?? resolved.objectUrl,
    license: resolved.license,
    image: `images/display/${seed.slug}.jpg`,
    zoom: `images/zoom/${seed.slug}.jpg`,
    audio: `audio/${seed.slug}.m4a`,
    wallpaper: `images/wall/${seed.slug}.jpg`,
    wallpaperIpad: `images/wall-ipad/${seed.slug}.jpg`,
    home: `images/home/${seed.slug}.jpg`,
    homeIpad: `images/home-ipad/${seed.slug}.jpg`,
    lesson: seed.lesson.trim(),
    lookFor: seed.lookFor.trim(),
  }));

  const manifest = { version: 1, anchor: '2026-01-01', count: items.length, items };
  await writeFile(path.join(SITE, 'artworks.json'), JSON.stringify(manifest, null, 1));
  console.log(`wrote site/artworks.json (${items.length} artworks)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
