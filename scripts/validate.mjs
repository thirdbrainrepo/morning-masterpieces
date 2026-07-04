#!/usr/bin/env node
// Collection-wide integrity gate — read-only, no network, fast.
//
// The deploy workflow's today.mjs only proves TODAY's files exist; this
// proves the whole collection is structurally sound, so a missing or
// corrupt asset for any future day can't deploy silently and ambush a
// morning weeks later. Run before every deploy and after every wave.
//
// Deliberately offline: museum/Commons verification (build.mjs
// --verify-only) has different reliability characteristics and stays a
// separate, explicit step.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seeds } from '../data/seeds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

async function fileSize(rel) {
  try { return (await stat(path.join(SITE, rel))).size; } catch { return -1; }
}

const manifest = JSON.parse(await readFile(path.join(SITE, 'artworks.json'), 'utf8'));
const items = manifest.items ?? [];

check(items.length > 0, 'manifest has no items');
check(manifest.count === items.length, `manifest count ${manifest.count} != items ${items.length}`);
check(manifest.anchor === '2026-01-01', `anchor changed to ${manifest.anchor} — this remaps every day`);

// Seeds and manifest must agree in length AND order: the daily index is
// positional, so silent reordering reassigns dates.
check(seeds.length === items.length, `seeds (${seeds.length}) != manifest items (${items.length})`);
seeds.forEach((s, i) =>
  check(items[i]?.slug === s.slug, `order mismatch at ${i}: seed "${s.slug}" vs manifest "${items[i]?.slug}"`));
seeds.forEach((s) => check(!!s.expect, `seed ${s.slug} missing required "expect"`));

const seen = new Set();
for (const it of items) {
  check(!seen.has(it.slug), `duplicate slug ${it.slug}`);
  seen.add(it.slug);
}

const REQUIRED = ['slug', 'title', 'artist', 'year', 'medium', 'movement', 'museum',
  'objectUrl', 'imageSourceUrl', 'license', 'image', 'zoom', 'audio',
  'wallpaper', 'wallpaperIpad', 'home', 'homeIpad', 'lesson', 'lookFor'];
// [asset field, minimum plausible bytes] — a 0-byte or truncated-to-nothing
// file is the realistic corruption, not a subtly wrong one.
const ASSETS = [['image', 20_000], ['zoom', 50_000], ['wallpaper', 100_000],
  ['wallpaperIpad', 100_000], ['home', 50_000], ['homeIpad', 50_000], ['audio', 100_000]];

const hashes = JSON.parse(await readFile(path.join(SITE, 'audio', 'hashes.json'), 'utf8'));

for (const it of items) {
  for (const f of REQUIRED) check(it[f] != null && it[f] !== '', `${it.slug}: missing field "${f}"`);
  for (const [f, min] of ASSETS) {
    const rel = it[f];
    if (!rel) continue;
    check(/^(images|audio)\//.test(rel) && !rel.includes('..'), `${it.slug}: suspicious path "${rel}"`);
    const size = await fileSize(rel);
    check(size >= min, `${it.slug}: ${f} (${rel}) ${size < 0 ? 'MISSING' : `only ${size} bytes`}`);
  }
  check(!!hashes[it.slug], `${it.slug}: no entry in audio/hashes.json`);
}
for (const slug of Object.keys(hashes)) {
  check(seen.has(slug), `hashes.json orphan entry "${slug}"`);
}

// Files the service worker precaches — a missing one fails installation.
for (const shell of ['index.html', 'shortcuts.html', 'styles.css', 'app.js',
  'manifest.webmanifest', 'sw.js']) {
  check((await fileSize(shell)) > 0, `shell file missing: ${shell}`);
}

// The deterministic index, same formula as app.js/today.mjs: anchor day is
// item 0, and the rotation wraps at the collection length.
const idx = (ymd) => {
  const days = Math.round((Date.parse(ymd) - Date.parse(manifest.anchor)) / 86_400_000);
  return ((days % items.length) + items.length) % items.length;
};
const wrapDay = new Date(Date.parse(manifest.anchor) + items.length * 86_400_000)
  .toISOString().slice(0, 10);
check(idx('2026-01-01') === 0, 'index formula: anchor day is not item 0');
check(idx(wrapDay) === 0, `index formula: day ${items.length} (${wrapDay}) did not wrap to 0`);
check(idx('2025-12-31') === items.length - 1, 'index formula: day before anchor is not the last item');

if (problems.length) {
  console.error(`VALIDATION FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`validate: ${items.length} works, ${items.length * ASSETS.length} assets, hashes, shell, index math — all OK`);
