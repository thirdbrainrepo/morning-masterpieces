#!/usr/bin/env node
// Render Gallery Companion audio stops (data/visit/*.mjs) through the same
// Chatterbox voice + pacing as the daily docent (keep constants in sync
// with narrate.mjs). Outputs site/visit/audio/<stop-id>.m4a with an
// incremental hash file, exactly like the gallery pipeline.
//
// Usage:
//   node scripts/narrate-visit.mjs             render missing/stale stops
//   node scripts/narrate-visit.mjs --stop=<id> render one stop

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { visit } from '../data/visit/monet-venice.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site', 'visit', 'audio');
const HASHES = path.join(ROOT, 'site', 'visit', 'hashes.json');

const TTS_URL = 'http://localhost:8100/v1/audio/speech';
const TTS_MODEL = 'mlx-community/Chatterbox-Turbo-TTS-fp16';
const REF_AUDIO = path.join(ROOT, 'data', 'voice', 'hanna.wav');
const PAUSE_BETWEEN = 0.65;
const MERGE_TARGET = 210;
const ENCODE = 'loudnorm=I=-16:TP=-1.5|aac|80k|mono';
const RENDERER_VERSION = 1;

const speakable = (t) => t
  .replace(/(\d)–(\d)/g, '$1 to $2')
  .replace(/—/g, ', ')
  .replace(/\bc\.\s?(\d)/g, 'circa $1')
  .replace(/\bNo\.\s?(\d)/g, 'Number $1')
  .replace(/\bGogh\b/g, 'Goth')
  .replace(/\s+/g, ' ')
  .trim();

function mergeSentences(text, target) {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const merged = [parts[0]];
  for (const s of parts.slice(1)) {
    if (merged[merged.length - 1].length < target) merged[merged.length - 1] += ` ${s}`;
    else merged.push(s);
  }
  if (merged.length > 1 && merged[merged.length - 1].length < 90) {
    merged[merged.length - 2] += ` ${merged.pop()}`;
  }
  return merged;
}

async function renderChunk(text, outWav) {
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL, input: text, ref_audio: REF_AUDIO, response_format: 'wav',
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  await writeFile(outWav, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  const onlyStop = process.argv.find((a) => a.startsWith('--stop='))?.slice(7);
  const stops = visit.stops.filter((s) => !onlyStop || s.id === onlyStop);
  if (!stops.length) throw new Error(`no such stop: ${onlyStop}`);

  // The page renders itself from this manifest — texts stay single-sourced
  // in data/visit/ and travel with the audio.
  await mkdir(path.dirname(HASHES), { recursive: true });
  await writeFile(path.join(ROOT, 'site', 'visit', 'monet-venice.json'), JSON.stringify({
    id: visit.id,
    title: visit.title,
    venue: visit.venue,
    closes: visit.closes,
    stops: visit.stops.map(({ id, title, text }) => ({ id, title, text })),
  }, null, 1));
  console.log('wrote site/visit/monet-venice.json');

  const up = await fetch('http://localhost:8100/docs').then((r) => r.ok).catch(() => false);
  if (!up) throw new Error('Chatterbox TTS server is not running on localhost:8100');

  const voiceHash = createHash('sha256').update(await readFile(REF_AUDIO)).digest('hex').slice(0, 16);
  await mkdir(OUT, { recursive: true });
  const hashes = existsSync(HASHES) ? JSON.parse(await readFile(HASHES, 'utf8')) : {};
  const tmp = path.join(os.tmpdir(), `narrate-visit-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  const silences = new Map();
  const silenceFor = async (secs) => {
    if (!silences.has(secs)) {
      const f = path.join(tmp, `silence-${secs}.wav`);
      await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(secs), f]);
      silences.set(secs, f);
    }
    return silences.get(secs);
  };

  let rendered = 0;
  try {
    for (const stop of stops) {
      const script = speakable(stop.text);
      const hash = createHash('sha256')
        .update([script, voiceHash, TTS_MODEL, MERGE_TARGET, PAUSE_BETWEEN, ENCODE, RENDERER_VERSION].join('|'))
        .digest('hex').slice(0, 16);
      const out = path.join(OUT, `${stop.id}.m4a`);
      if (hashes[stop.id] === hash && existsSync(out)) {
        console.log(`[skip] ${stop.id} (unchanged)`);
        continue;
      }
      process.stdout.write(`[render] ${stop.id} ... `);
      const passages = mergeSentences(script, MERGE_TARGET);
      const listLines = [];
      for (let i = 0; i < passages.length; i++) {
        const raw = path.join(tmp, `${stop.id}-${i}-raw.wav`);
        const norm = path.join(tmp, `${stop.id}-${i}.wav`);
        await renderChunk(passages[i], raw);
        await run('ffmpeg', ['-y', '-i', raw, '-ar', '44100', '-ac', '1', norm]);
        listLines.push(`file '${norm}'`);
        if (i < passages.length - 1) listLines.push(`file '${await silenceFor(PAUSE_BETWEEN)}'`);
      }
      const list = path.join(tmp, `${stop.id}-list.txt`);
      await writeFile(list, listLines.join('\n') + '\n');
      await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-af', 'loudnorm=I=-16:TP=-1.5', '-ar', '44100', '-c:a', 'aac', '-b:a', '80k', out]); // -ar pinned: loudnorm upsamples and unpinned output landed at 96kHz, which visionOS decodeAudioData rejects (fleet re-encoded in place 2026-07-12)
      hashes[stop.id] = hash;
      await writeFile(HASHES, JSON.stringify(hashes, null, 1));
      const { stdout } = await run('ffprobe', ['-v', 'quiet', '-show_entries',
        'format=duration', '-of', 'csv=p=0', out]);
      console.log(`${passages.length} chunks, ${Math.round(parseFloat(stdout))}s`);
      rendered++;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`\n${rendered} rendered, ${stops.length - rendered} skipped`);
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
