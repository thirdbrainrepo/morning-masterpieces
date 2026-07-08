#!/usr/bin/env node
// Transcribe narrations and machine-check them for TTS defects.
//
// Chatterbox renders occasionally stutter (a phrase spoken twice in a row)
// or drop whole sentences — the 2026-07-08 sweep found 5 defective takes
// in 50 (plus one caught by ear). ASR transcription catches both failure
// modes without listening:
//   - a repeated 5-gram within a 40-word window that the SOURCE text does
//     not itself repeat (titles quoted in lessons legitimately recur)
//   - transcript/source word-count ratio outside [0.93, 1.10]
//     (clean takes score 0.97–1.00; ASR mishears words but keeps count)
//
// Requires the scribe transcriber (Trail of Bits parakeet-mlx wrapper) at
// ../scribe relative to this repo. Fix flagged works by deleting their
// hashes.json entry and re-running narrate.mjs --slug=<slug>, then
// re-check — takes are stochastic, so one bad roll usually re-rolls clean.
//
// Usage:
//   node scripts/check-narrations.mjs                 check all 50
//   node scripts/check-narrations.mjs --slug=<slug>   check one

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIBE = path.resolve(ROOT, '..', 'scribe');
const TMP = path.join(os.tmpdir(), `check-narrations-${process.pid}`);
const CONCURRENCY = 3;

// Mirrors speakable()/scriptFor() in narrate.mjs — keep in sync.
const speakable = (t) => t
  .replace(/(\d)–(\d)/g, '$1 to $2')
  .replace(/—/g, ', ')
  .replace(/\bc\.\s?(\d)/g, 'circa $1')
  .replace(/\bNo\.\s?(\d)/g, 'Number $1')
  .replace(/\s+/g, ' ')
  .trim();
const scriptFor = (i) =>
  speakable(`${i.title}. ${i.artist}, ${i.year}. ${i.lesson} Look closer. ${i.lookFor}`);

// Normalize for comparison: ASR writes "number one" where the source has
// "No. 1", so small digits become words on both sides.
const DIGITS = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
  5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
const words = (t) => t.toLowerCase()
  .replace(/\bno\.\s*(\d)/g, 'number $1')
  .replace(/[^a-z0-9' ]+/g, ' ')
  .split(/\s+/).filter(Boolean)
  .map((w) => DIGITS[w] ?? w);

function check(transcript, expected) {
  const tw = words(transcript);
  const ew = words(expected);
  const ratio = tw.length / ew.length;
  const ecount = new Map();
  for (let i = 0; i + 5 <= ew.length; i++) {
    const g = ew.slice(i, i + 5).join(' ');
    ecount.set(g, (ecount.get(g) ?? 0) + 1);
  }
  const flags = [];
  const seen = new Map();
  for (let i = 0; i + 5 <= tw.length; i++) {
    const g = tw.slice(i, i + 5).join(' ');
    if (seen.has(g) && i - seen.get(g) <= 40 && i - seen.get(g) >= 5 && (ecount.get(g) ?? 0) < 2) {
      flags.push(`REPEAT: "${g}"`);
      break;
    }
    if (!seen.has(g)) seen.set(g, i);
  }
  if (ratio < 0.93) flags.push(`SHORT: ${tw.length}/${ew.length} words (${ratio.toFixed(2)}) — content likely dropped`);
  if (ratio > 1.10) flags.push(`LONG: ${tw.length}/${ew.length} words (${ratio.toFixed(2)}) — content likely repeated`);
  return { ratio, flags };
}

const onlySlug = process.argv.find((a) => a.startsWith('--slug='))?.slice(7);
const manifest = JSON.parse(await readFile(path.join(ROOT, 'site/artworks.json'), 'utf8'));
const queue = manifest.items.filter((i) => !onlySlug || i.slug === onlySlug);
if (!queue.length) throw new Error(`no such slug: ${onlySlug}`);

await run('mkdir', ['-p', TMP]);
const results = [];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    const md = path.join(TMP, `${item.slug}.md`);
    try {
      await run('uv', ['run', 'scribe.py', '--no-diarize',
        path.join(ROOT, 'site/audio', `${item.slug}.m4a`), '-o', md],
        { cwd: SCRIBE, timeout: 300_000 });
      const { ratio, flags } = check(await readFile(md, 'utf8'), scriptFor(item));
      results.push({ slug: item.slug, flags });
      console.log(`${flags.length ? 'FLAG' : ' ok '} ${item.slug} ${ratio.toFixed(2)} ${flags.join(' | ')}`);
    } catch (err) {
      results.push({ slug: item.slug, flags: [`ERROR: ${err.message?.slice(0, 100)}`] });
      console.log(`FAIL ${item.slug}: ${err.message?.slice(0, 100)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
await run('rm', ['-rf', TMP]);

const flagged = results.filter((r) => r.flags.length);
console.log(`\n${results.length} checked, ${flagged.length} flagged${flagged.length ? ': ' + flagged.map((f) => f.slug).join(', ') : ''}`);
if (flagged.length) process.exitCode = 1;
