#!/usr/bin/env node
// Transcript-screen the Gallery Companion stops, mirroring
// check-narrations.mjs (same detectors: source-whitelisted 5-gram repeats,
// back-to-back 3-8 word stutters, word-count ratio 0.93-1.10).
//
// Usage: node scripts/check-visit.mjs [--stop=<id>]

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visit } from '../data/visit/monet-venice.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIBE = path.resolve(ROOT, '..', 'scribe');
const TMP = path.join(os.tmpdir(), `check-visit-${process.pid}`);
const CONCURRENCY = 3;

const speakable = (t) => t
  .replace(/(\d)–(\d)/g, '$1 to $2')
  .replace(/—/g, ', ')
  .replace(/\bc\.\s?(\d)/g, 'circa $1')
  .replace(/\bNo\.\s?(\d)/g, 'Number $1')
  .replace(/\bGogh\b/g, 'Goth')
  .replace(/\s+/g, ' ')
  .trim();

const DIGITS = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
  5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
const words = (t) => t.toLowerCase()
  .replace(/\bno\.\s*(\d)/g, 'number $1')
  .replace(/[^a-z0-9' ]+/g, ' ')
  .split(/\s+/).filter(Boolean)
  .map((w) => w === 'gogh' ? 'goth' : (DIGITS[w] ?? w));

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
  const ejoined = ew.join(' ');
  outer: for (let n = 3; n <= 8; n++) {
    for (let i = 0; i + 2 * n <= tw.length; i++) {
      const a = tw.slice(i, i + n).join(' ');
      if (a === tw.slice(i + n, i + 2 * n).join(' ') && !ejoined.includes(`${a} ${a}`)) {
        flags.push(`STUTTER: "${a}" doubled back-to-back`);
        break outer;
      }
    }
  }
  if (ratio < 0.93) flags.push(`SHORT: ${tw.length}/${ew.length} (${ratio.toFixed(2)})`);
  if (ratio > 1.10) flags.push(`LONG: ${tw.length}/${ew.length} (${ratio.toFixed(2)})`);
  return { ratio, flags };
}

const onlyStop = process.argv.find((a) => a.startsWith('--stop='))?.slice(7);
const queue = visit.stops.filter((s) => !onlyStop || s.id === onlyStop);
if (!queue.length) throw new Error(`no such stop: ${onlyStop}`);

await run('mkdir', ['-p', TMP]);
const results = [];
async function worker() {
  while (queue.length) {
    const stop = queue.shift();
    const md = path.join(TMP, `${stop.id}.md`);
    try {
      await run('uv', ['run', 'scribe.py', '--no-diarize',
        path.join(ROOT, 'site/visit/audio', `${stop.id}.m4a`), '-o', md],
        { cwd: SCRIBE, timeout: 300_000 });
      const { ratio, flags } = check(await readFile(md, 'utf8'), speakable(stop.text));
      results.push({ id: stop.id, flags });
      console.log(`${flags.length ? 'FLAG' : ' ok '} ${stop.id} ${ratio.toFixed(2)} ${flags.join(' | ')}`);
    } catch (err) {
      results.push({ id: stop.id, flags: [`ERROR: ${err.message?.slice(0, 100)}`] });
      console.log(`FAIL ${stop.id}: ${err.message?.slice(0, 100)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
await run('rm', ['-rf', TMP]);

const flagged = results.filter((r) => r.flags.length);
console.log(`\n${results.length} checked, ${flagged.length} flagged${flagged.length ? ': ' + flagged.map((f) => f.id).join(', ') : ''}`);
if (flagged.length) process.exitCode = 1;
