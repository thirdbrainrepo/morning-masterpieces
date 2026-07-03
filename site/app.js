// Morning Masterpieces — deterministic daily artwork.
//
// The daily pick is computed, not stored: days elapsed since the manifest's
// anchor date (at local midnight), modulo the rotation length. The iOS
// Shortcut and the GitHub Action derive the same index from the same
// formula, so every surface agrees on what "today" is with no shared state.

const $ = (id) => document.getElementById(id);
let manifest = null;
let offset = 0; // days relative to today; 0 = today

function localYMD(date) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function indexFor(date) {
  const days = Math.round(
    (Date.parse(localYMD(date)) - Date.parse(manifest.anchor)) / 86_400_000
  );
  const n = manifest.items.length;
  return ((days % n) + n) % n;
}

function currentItem() {
  return manifest.items[indexFor(new Date(Date.now() + offset * 86_400_000))];
}

function render() {
  const date = new Date(Date.now() + offset * 86_400_000);
  const idx = indexFor(date);
  const item = manifest.items[idx];

  stopDocent(); // navigation ends the current reading

  $('dateline').textContent = date.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  $('daycount').textContent = `No. ${idx + 1} of ${manifest.items.length}`;

  const img = $('art-image');
  img.src = item.image;
  img.alt = `${item.title} by ${item.artist}`;

  $('art-title').textContent = item.title;
  $('art-artist').textContent = item.artist;
  $('art-artist-dates').textContent = item.artistDates ? `(${item.artistDates})` : '';
  $('art-year').textContent = item.year;
  $('art-medium').textContent = item.medium;
  $('art-movement').textContent = item.movement;
  $('art-museum').textContent = item.museum;

  const lessonEl = $('art-lesson');
  lessonEl.innerHTML = '';
  for (const para of item.lesson.split(/\n\n+/)) {
    const p = document.createElement('p');
    p.textContent = para;
    lessonEl.appendChild(p);
  }
  $('art-lookfor').textContent = item.lookFor;

  $('museum-link').href = item.objectUrl;
  const wall = $('wallpaper-link');
  wall.href = item.wallpaper;
  wall.download = `${item.slug}-wallpaper-iphone.jpg`;
  const wallIpad = $('wallpaper-ipad-link');
  wallIpad.href = item.wallpaperIpad;
  wallIpad.download = `${item.slug}-wallpaper-ipad.jpg`;
  $('art-license').textContent = `Image: ${item.license}`;

  $('today-btn').style.visibility = offset === 0 ? 'hidden' : 'visible';
  document.title = offset === 0
    ? 'Morning Masterpieces'
    : `${item.title} — Morning Masterpieces`;
  window.scrollTo({ top: 0 });
  $('panel').scrollTop = 0;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function askPrompt() {
  const item = currentItem();
  const text =
    `I'm looking at "${item.title}" (${item.year}) by ${item.artist}, ` +
    `${item.medium.toLowerCase()}, now in the collection of ${item.museum}. ` +
    `Tell me more about this work — its historical context, technique, and why it matters.`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Prompt copied — paste it to any assistant');
  } catch {
    toast('Could not copy');
  }
}

/* ── Docent ─────────────────────────────────────────────────────────
   Preferred path: pre-rendered narration (audio/<slug>.m4a, neural TTS
   rendered offline). Fallback when the file is missing or fails to load:
   on-device SpeechSynthesis, chunked at sentence boundaries because very
   long utterances can be cut off by the engine. */

const docent = { playing: false, audio: null };

function bestVoice() {
  const lang = navigator.language || 'en-US';
  const voices = speechSynthesis.getVoices()
    .filter((v) => v.lang.startsWith(lang.slice(0, 2)));
  return (
    voices.find((v) => /premium|enhanced/i.test(v.name)) ||
    voices.find((v) => v.lang === lang && v.localService) ||
    voices.find((v) => v.default) ||
    voices[0] || null
  );
}

function docentChunks(item) {
  const script =
    `${item.title}. ${item.artist}, ${item.year}. ` +
    `${item.lesson} ... Look closer. ${item.lookFor}`;
  const sentences = script.split(/(?<=[.!?])\s+(?=[A-Z“"'])/);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur.length + s.length) > 250) { chunks.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function updateDocentUI() {
  $('listen-btn').textContent = docent.playing
    ? '■ Stop the docent'
    : 'Listen — the docent reads today’s lesson';
  $('lightbox-listen').textContent = docent.playing ? '■ Stop' : 'Listen';
}

function stopDocent() {
  docent.playing = false;
  if (docent.audio) {
    docent.audio.pause();
    docent.audio.removeAttribute('src');
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  updateDocentUI();
}

function speakFallback(item) {
  if (!('speechSynthesis' in window)) { stopDocent(); toast('Audio is not available here'); return; }
  const chunks = docentChunks(item);
  const voice = bestVoice();
  let i = 0;
  const next = () => {
    if (!docent.playing || i >= chunks.length) { stopDocent(); return; }
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    if (voice) u.voice = voice;
    u.rate = 0.95;
    u.onend = next;
    u.onerror = () => stopDocent();
    speechSynthesis.speak(u);
  };
  next();
}

function startDocent() {
  stopDocent();
  const item = currentItem();
  docent.playing = true;
  updateDocentUI();

  if (item.audio) {
    const a = docent.audio ?? (docent.audio = new Audio());
    a.onended = () => stopDocent();
    a.onerror = () => { if (docent.playing) speakFallback(item); };
    a.src = item.audio;
    a.play().catch(() => { if (docent.playing) speakFallback(item); });
    return;
  }
  speakFallback(item);
}

function toggleDocent() {
  docent.playing ? stopDocent() : startDocent();
}

/* ── Fullscreen viewer ────────────────────────────────────────────── */

let hintTimer = null;

function updateRotateHint() {
  const img = $('lightbox-img');
  if (!img.naturalWidth) return;
  const mismatch =
    (img.naturalWidth > img.naturalHeight) !== (innerWidth > innerHeight);
  const hint = $('rotate-hint');
  clearTimeout(hintTimer);
  hint.hidden = !mismatch;
  if (mismatch) hintTimer = setTimeout(() => { hint.hidden = true; }, 3500);
}

function openLightbox() {
  const item = currentItem();
  const img = $('lightbox-img');
  img.src = item.zoom || item.image;
  img.alt = `${item.title} by ${item.artist}`;
  img.onload = updateRotateHint;
  $('lightbox').hidden = false;
  document.body.classList.add('lightbox-open');
  const lb = $('lightbox');
  (lb.requestFullscreen?.() ?? lb.webkitRequestFullscreen?.())?.catch?.(() => {});
}

function closeLightbox() {
  $('lightbox').hidden = true;
  document.body.classList.remove('lightbox-open');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function init() {
  const res = await fetch('artworks.json');
  manifest = await res.json();

  $('main').hidden = false;
  $('pager').hidden = false;
  render();

  $('prev-btn').addEventListener('click', () => { offset -= 1; render(); });
  $('next-btn').addEventListener('click', () => { offset += 1; render(); });
  $('today-btn').addEventListener('click', () => { offset = 0; render(); });
  $('ask-btn').addEventListener('click', askPrompt);
  $('listen-btn').addEventListener('click', toggleDocent);
  $('lightbox-listen').addEventListener('click', toggleDocent);

  $('fullscreen-btn').addEventListener('click', openLightbox);
  $('art-image').addEventListener('click', openLightbox);
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox') || e.target === $('lightbox-img')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox();
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && !$('lightbox').hidden) closeLightbox();
  });
  addEventListener('resize', () => {
    if (!$('lightbox').hidden) updateRotateHint();
  });

  // iOS populates the voice list lazily; warming it here means the first
  // docent tap already has the good voices available.
  if ('speechSynthesis' in window) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init().catch((err) => {
  $('dateline').textContent = 'Could not load the collection.';
  console.error(err);
});
