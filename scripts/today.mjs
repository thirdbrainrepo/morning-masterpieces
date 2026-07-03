#!/usr/bin/env node
// Materialize "today" as stable static URLs, so the iOS Shortcut needs zero
// logic: it just fetches today/wallpaper.jpg. Run daily by GitHub Actions
// (with TZ=America/Los_Angeles) before deploying the site.
//
// The index formula here MUST match site/app.js: days since the anchor date,
// modulo the number of artworks, computed against local-timezone midnight.

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

const manifest = JSON.parse(await readFile(path.join(SITE, 'artworks.json'), 'utf8'));
const { items, anchor } = manifest;

// Local calendar date as YYYY-MM-DD (honors the TZ env var).
const today = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const days = Math.round((Date.parse(today) - Date.parse(anchor)) / 86_400_000);
const index = ((days % items.length) + items.length) % items.length;
const item = items[index];

await mkdir(path.join(SITE, 'today'), { recursive: true });
await copyFile(path.join(SITE, item.wallpaper), path.join(SITE, 'today', 'wallpaper.jpg'));
await copyFile(path.join(SITE, item.wallpaperIpad), path.join(SITE, 'today', 'wallpaper-ipad.jpg'));
await copyFile(path.join(SITE, item.image), path.join(SITE, 'today', 'image.jpg'));

await writeFile(
  path.join(SITE, 'today.json'),
  JSON.stringify({ date: today, index, count: items.length, item }, null, 1)
);

console.log(`today.json -> ${today} = #${index + 1}/${items.length}: ${item.title} (${item.artist})`);
