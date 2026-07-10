#!/usr/bin/env node
// Materialize "today" as stable static URLs, so the iOS Shortcut needs zero
// logic: it just fetches today/wallpaper.jpg. Run daily by GitHub Actions
// (with TZ=America/Los_Angeles) via roll.yml.
//
// Rotation logic MUST match site/app.js: an exhibition whose run covers
// today supplies the daily work (day = days since ITS opening); otherwise
// the permanent collection does (days since anchor, mod length).

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

const manifest = JSON.parse(await readFile(path.join(SITE, 'artworks.json'), 'utf8'));
const { items, anchor } = manifest;
const exPath = path.join(SITE, 'exhibitions.json');
const exhibitions = existsSync(exPath)
  ? JSON.parse(await readFile(exPath, 'utf8')).exhibitions
  : [];

// Local calendar date as YYYY-MM-DD (honors the TZ env var).
const today = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const daysSince = (ymd) => Math.round((Date.parse(today) - Date.parse(ymd)) / 86_400_000);

let item;
let exhibition = null;
const active = exhibitions.find((e) => {
  const d = daysSince(e.opens);
  return d >= 0 && d < e.items.length;
});
if (active) {
  const day = daysSince(active.opens);
  item = active.items[day];
  exhibition = { id: active.id, title: active.title, day: day + 1, count: active.items.length };
} else {
  const days = daysSince(anchor);
  const index = ((days % items.length) + items.length) % items.length;
  item = items[index];
}
const index = items.findIndex((i) => i.slug === item.slug); // PC index if present, else -1

await mkdir(path.join(SITE, 'today'), { recursive: true });
await copyFile(path.join(SITE, item.wallpaper), path.join(SITE, 'today', 'wallpaper.jpg'));
await copyFile(path.join(SITE, item.wallpaperIpad), path.join(SITE, 'today', 'wallpaper-ipad.jpg'));
await copyFile(path.join(SITE, item.home), path.join(SITE, 'today', 'home.jpg'));
await copyFile(path.join(SITE, item.homeIpad), path.join(SITE, 'today', 'home-ipad.jpg'));
await copyFile(path.join(SITE, item.image), path.join(SITE, 'today', 'image.jpg'));

await writeFile(
  path.join(SITE, 'today.json'),
  JSON.stringify({ date: today, index, count: items.length, exhibition, item }, null, 1)
);

const label = exhibition
  ? `"${exhibition.title}" day ${exhibition.day}/${exhibition.count}`
  : `#${index + 1}/${items.length}`;
console.log(`today.json -> ${today} = ${label}: ${item.title} (${item.artist})`);
