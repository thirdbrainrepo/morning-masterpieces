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
const REF_AUDIO = '/Users/staticzero/Developer/luna-voice/voices/cleo.wav';

// Light normalization for speech: things the eye parses but a TTS mangles.
function speakable(text) {
  return text
    .replace(/(\d)–(\d)/g, '$1 to $2')   // year ranges: 1884–86
    .replace(/—/g, ', ')                  // em dashes read as pauses
    .replace(/\bc\.\s?(\d)/g, 'circa $1') // c. 1665
    .replace(/\bNo\.\s?(\d)/g, 'Number $1')
    .replace(/\s+/g, ' ')
    .trim();
}

function scriptFor(item) {
  return speakable(
    `${item.title}. ${item.artist}, ${item.year}. ${item.lesson} Look closer. ${item.lookFor}`
  );
}

// Same chunking speak.sh uses: merge sentences into ~250-400 char chunks.
function chunk(text) {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const merged = [parts[0]];
  for (const s of parts.slice(1)) {
    if (merged[merged.length - 1].length < 250) merged[merged.length - 1] += ` ${s}`;
    else merged.push(s);
  }
  if (merged.length > 1 && merged[merged.length - 1].length < 100) {
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

async function narrate(item, tmp, silence) {
  const chunks = chunk(scriptFor(item));
  const wavs = [];
  for (let i = 0; i < chunks.length; i++) {
    const raw = path.join(tmp, `${item.slug}-${i}-raw.wav`);
    const norm = path.join(tmp, `${item.slug}-${i}.wav`);
    await renderChunk(chunks[i], raw);
    // Normalize every chunk to identical params so the concat demuxer is safe.
    await run('ffmpeg', ['-y', '-i', raw, '-ar', '44100', '-ac', '1', norm]);
    wavs.push(norm);
  }
  const list = path.join(tmp, `${item.slug}-list.txt`);
  await writeFile(list, wavs.map((w) => `file '${w}'`).join(`\nfile '${silence}'\n`) + '\n');
  const out = path.join(AUDIO, `${item.slug}.m4a`);
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-af', 'loudnorm=I=-16:TP=-1.5', '-c:a', 'aac', '-b:a', '80k', out]);
  return { out, chunks: chunks.length };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyToday = args.includes('--today');
  const onlySlug = args.find((a) => a.startsWith('--slug='))?.slice(7);

  const manifest = JSON.parse(await readFile(path.join(SITE, 'artworks.json'), 'utf8'));
  let items = manifest.items;

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

  const up = await fetch('http://localhost:8100/docs').then((r) => r.ok).catch(() => false);
  if (!up) throw new Error('Chatterbox TTS server is not running on localhost:8100');

  await mkdir(AUDIO, { recursive: true });
  const hashes = existsSync(HASHES) ? JSON.parse(await readFile(HASHES, 'utf8')) : {};
  const tmp = path.join(os.tmpdir(), `narrate-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  const silence = path.join(tmp, 'silence.wav');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.35', silence]);

  let rendered = 0;
  for (const item of items) {
    const hash = createHash('sha256').update(scriptFor(item)).digest('hex').slice(0, 16);
    const out = path.join(AUDIO, `${item.slug}.m4a`);
    if (hashes[item.slug] === hash && existsSync(out)) {
      console.log(`[skip] ${item.slug} (unchanged)`);
      continue;
    }
    process.stdout.write(`[render] ${item.slug} ... `);
    const { chunks } = await narrate(item, tmp, silence);
    hashes[item.slug] = hash;
    await writeFile(HASHES, JSON.stringify(hashes, null, 1));
    const { stdout } = await run('ffprobe', ['-v', 'quiet', '-show_entries',
      'format=duration', '-of', 'csv=p=0', out]);
    console.log(`${chunks} chunks, ${Math.round(parseFloat(stdout))}s`);
    rendered++;
  }

  await rm(tmp, { recursive: true, force: true });
  console.log(`\n${rendered} rendered, ${items.length - rendered} skipped`);
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
