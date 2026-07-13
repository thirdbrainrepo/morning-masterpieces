#!/usr/bin/env node
// Pre-render docent narration through the local Chatterbox Turbo server.
//
// Reads site/artworks.json, builds the spoken script for each work (same
// text the PWA's SpeechSynthesis fallback reads), renders it chunk by chunk
// via the OpenAI-compatible /v1/audio/speech endpoint, and assembles
// site/audio/<slug>.m4a (mono AAC, loudness-normalized).
//
// site/audio/hashes.json records a hash of each work's script text, so
// re-runs only render lessons whose text changed.
//
// Usage:
//   node scripts/narrate.mjs --today          render only today's work
//   node scripts/narrate.mjs --slug=<slug>    render one work
//   node scripts/narrate.mjs                  render everything missing/stale
//   node scripts/narrate.mjs --rekey          rewrite hashes.json for existing
//                                             audio WITHOUT rendering — only
//                                             after a hash-scheme change when
//                                             the current files are known good
//
// Requires: the Chatterbox server (localhost:8100) and ffmpeg.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const AUDIO = path.join(SITE, 'audio');
const HASHES = path.join(AUDIO, 'hashes.json');

const TTS_URL = 'http://localhost:8100/v1/audio/speech';
const TTS_MODEL = 'mlx-community/Chatterbox-Turbo-TTS-fp16';

// The docent's voice: vendored into the repo so every future wave of works
// renders identically. Changing this file (or the PAUSE_* constants below)
// invalidates every hash and re-renders the whole gallery — intended when
// deliberately re-voicing, expensive otherwise.
const REF_AUDIO = path.join(ROOT, 'data', 'voice', 'hanna.wav');

// Deliberate pacing (seconds of silence): a breath after the tombstone
// intro, thinking room between passages, and a long contemplative beat
// before the "look closer" coda.
const PAUSE_INTRO = 1.1;
const PAUSE_BETWEEN = 0.65;
const PAUSE_CODA = 1.2;

// Everything below also shapes the rendered audio, so it all feeds the
// narration hash. Bump RENDERER_VERSION for behavior changes the constants
// don't capture (segmenting logic, speakable() rules, ffmpeg pipeline).
const MERGE_TARGET = 210;               // chars per merged lesson passage
const ENCODE = 'loudnorm=I=-16:TP=-1.5|aac|80k|mono';
const RENDERER_VERSION = 1;

// Light normalization for speech: things the eye parses but a TTS mangles.
function speakable(text) {
  return text
    .replace(/(\d)–(\d)/g, '$1 to $2')   // year ranges: 1884–86
    .replace(/—/g, ', ')                  // em dashes read as pauses
    .replace(/\bc\.\s?(\d)/g, 'circa $1') // c. 1665
    .replace(/\bNo\.\s?(\d)/g, 'Number $1')
    // Pronunciation pin: the model reads "Gogh" as American "Go" or
    // guttural "Goth" at random, per chunk. Paul chose "Goth" (2026-07-08);
    // the respell is spoken-script only and never reaches the screen.
    .replace(/\bGogh\b/g, 'Goth')
    .replace(/\s+/g, ' ')
    .trim();
}

function scriptFor(item) {
  return speakable(
    `${item.title}. ${item.artist}, ${item.year}. ${item.lesson} Look closer. ${item.lookFor}`
  );
}

// Merge sentences into passages of roughly `target` chars, breaking only
// at sentence boundaries (short chunks garble; long ones drone).
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

// The narration as paced segments: each rendered separately, followed by
// its own length of silence.
function segments(item) {
  const segs = [
    { text: speakable(`${item.title}. ${item.artist}, ${item.year}.`), pause: PAUSE_INTRO },
  ];
  const passages = mergeSentences(speakable(item.lesson), MERGE_TARGET);
  for (const p of passages) segs.push({ text: p, pause: PAUSE_BETWEEN });
  segs[segs.length - 1].pause = PAUSE_CODA;
  segs.push({ text: speakable(`Look closer. ${item.lookFor}`), pause: 0 });
  return segs;
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

async function narrate(item, tmp, silenceFor) {
  const segs = segments(item);
  const listLines = [];
  for (let i = 0; i < segs.length; i++) {
    const raw = path.join(tmp, `${item.slug}-${i}-raw.wav`);
    const norm = path.join(tmp, `${item.slug}-${i}.wav`);
    await renderChunk(segs[i].text, raw);
    // Normalize every chunk to identical params so the concat demuxer is safe.
    await run('ffmpeg', ['-y', '-i', raw, '-ar', '44100', '-ac', '1', norm]);
    listLines.push(`file '${norm}'`);
    if (segs[i].pause > 0) listLines.push(`file '${await silenceFor(segs[i].pause)}'`);
  }
  const list = path.join(tmp, `${item.slug}-list.txt`);
  await writeFile(list, listLines.join('\n') + '\n');
  const out = path.join(AUDIO, `${item.slug}.m4a`);
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-af', 'loudnorm=I=-16:TP=-1.5', '-ar', '44100', '-c:a', 'aac', '-b:a', '80k', out]); // -ar pinned: loudnorm upsamples and unpinned output landed at 96kHz, which visionOS decodeAudioData rejects (fleet re-encoded in place 2026-07-12)
  return { out, chunks: segs.length };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyToday = args.includes('--today');
  const rekey = args.includes('--rekey');
  const onlySlug = args.find((a) => a.startsWith('--slug='))?.slice(7);

  const manifest = JSON.parse(await readFile(path.join(SITE, 'artworks.json'), 'utf8'));
  // The narration catalog spans the permanent collection AND exhibition
  // works (exhibitions.json), deduped by slug.
  let items = manifest.items;
  const exPath = path.join(SITE, 'exhibitions.json');
  if (existsSync(exPath)) {
    const ex = JSON.parse(await readFile(exPath, 'utf8'));
    const have = new Set(items.map((i) => i.slug));
    for (const e of ex.exhibitions ?? []) {
      for (const item of e.items) if (!have.has(item.slug)) { items = items.concat(item); have.add(item.slug); }
    }
  }

  if (onlyToday) {
    const today = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const days = Math.round((Date.parse(today) - Date.parse(manifest.anchor)) / 86_400_000);
    items = [items[((days % items.length) + items.length) % items.length]];
  } else if (onlySlug) {
    items = items.filter((i) => i.slug === onlySlug);
    if (!items.length) throw new Error(`no such slug: ${onlySlug}`);
  }

  if (!rekey) {
    const up = await fetch('http://localhost:8100/docs').then((r) => r.ok).catch(() => false);
    if (!up) throw new Error('Chatterbox TTS server is not running on localhost:8100');
  }

  // The docent's identity is the voice FILE's bytes, not its filename —
  // swapping in a different hanna.wav must invalidate every narration.
  const voiceHash = createHash('sha256').update(await readFile(REF_AUDIO)).digest('hex').slice(0, 16);

  await mkdir(AUDIO, { recursive: true });
  const hashes = existsSync(HASHES) ? JSON.parse(await readFile(HASHES, 'utf8')) : {};
  const tmp = path.join(os.tmpdir(), `narrate-${process.pid}`);
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
    for (const item of items) {
      // The hash covers everything that shapes the output: script text, the
      // voice file's bytes, model, pacing, segmenting, and encoding — so
      // changing any of them re-renders on the next run.
      const hash = createHash('sha256')
        .update([scriptFor(item), voiceHash, TTS_MODEL, MERGE_TARGET,
          PAUSE_INTRO, PAUSE_BETWEEN, PAUSE_CODA, ENCODE, RENDERER_VERSION].join('|'))
        .digest('hex').slice(0, 16);
      const out = path.join(AUDIO, `${item.slug}.m4a`);
      if (rekey) {
        if (!existsSync(out)) throw new Error(`--rekey: ${item.slug}.m4a missing — render it instead`);
        hashes[item.slug] = hash;
        continue;
      }
      if (hashes[item.slug] === hash && existsSync(out)) {
        console.log(`[skip] ${item.slug} (unchanged)`);
        continue;
      }
      process.stdout.write(`[render] ${item.slug} ... `);
      const { chunks } = await narrate(item, tmp, silenceFor);
      hashes[item.slug] = hash;
      await writeFile(HASHES, JSON.stringify(hashes, null, 1));
      const { stdout } = await run('ffprobe', ['-v', 'quiet', '-show_entries',
        'format=duration', '-of', 'csv=p=0', out]);
      console.log(`${chunks} chunks, ${Math.round(parseFloat(stdout))}s`);
      rendered++;
    }
    if (rekey) {
      await writeFile(HASHES, JSON.stringify(hashes, null, 1));
      console.log(`rekeyed ${items.length} entries in hashes.json (no audio rendered)`);
      return;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`\n${rendered} rendered, ${items.length - rendered} skipped`);
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
