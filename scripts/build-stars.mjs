#!/usr/bin/env node
// Bake site/vision/stars.json from the HYG stellar database:
// every star to magnitude 6.5 (naked-eye sky, ~9k stars) as flat arrays
// [raDeg, decDeg, mag, colorIndex], rounded for size. Run rarely; the
// output is committed. Source: github.com/astronexus/HYG-Database (CC BY-SA,
// derived from Hipparcos/Yale/Gliese public catalogs).
//
// Usage: node scripts/build-stars.mjs [path-to-hyg.csv]
//        (downloads the CSV if no path given)

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site', 'vision', 'stars.json');
const URLS = [
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
  'https://raw.githubusercontent.com/astronexus/HYG-Database/master/hygdata_v3.csv',
];

let csv;
const local = process.argv[2];
if (local) {
  csv = await readFile(local, 'utf8');
} else {
  for (const url of URLS) {
    try {
      const res = await fetch(url);
      if (res.ok) { csv = await res.text(); console.log('fetched', url); break; }
    } catch { /* try next */ }
  }
  if (!csv) throw new Error('could not download HYG; pass a local CSV path');
}

const lines = csv.split('\n');
const unq = (s) => s?.replace(/^"|"$/g, '');
const header = lines[0].split(',').map(unq);
const col = (name) => header.indexOf(name);
const iRa = col('ra'), iDec = col('dec'), iMag = col('mag'), iCi = col('ci'), iProper = col('proper');
if (iRa < 0 || iDec < 0 || iMag < 0) throw new Error('unexpected HYG header: ' + lines[0]);

const ra = [], dec = [], mag = [], ci = [];
let polarisIdx = -1;
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(',');
  if (f.length < 5) continue;
  const m = parseFloat(unq(f[iMag]));
  if (!(m <= 6.5)) continue;
  const r = parseFloat(unq(f[iRa])), d = parseFloat(unq(f[iDec]));
  if (Number.isNaN(r) || Number.isNaN(d)) continue;
  if (m < -20) continue; // the Sun
  if (unq(f[iProper])?.trim() === 'Polaris') polarisIdx = ra.length;
  ra.push(Math.round(r * 15 * 1000) / 1000); // hours -> degrees
  dec.push(Math.round(d * 1000) / 1000);
  mag.push(Math.round(m * 100) / 100);
  ci.push(Math.round((parseFloat(unq(f[iCi])) || 0) * 100) / 100);
}

await writeFile(OUT, JSON.stringify({ count: ra.length, polaris: polarisIdx, ra, dec, mag, ci }));
console.log(`stars.json: ${ra.length} stars to mag 6.5, Polaris at index ${polarisIdx}`);
