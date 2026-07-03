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

function render() {
  const date = new Date(Date.now() + offset * 86_400_000);
  const idx = indexFor(date);
  const item = manifest.items[idx];

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
  $('wallpaper-link').href = item.wallpaper;
  $('art-license').textContent = `Image: ${item.license}`;

  $('today-btn').style.visibility = offset === 0 ? 'hidden' : 'visible';
  document.title = offset === 0
    ? 'Morning Masterpieces'
    : `${item.title} — Morning Masterpieces`;
  window.scrollTo({ top: 0 });
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function askPrompt() {
  const item = manifest.items[indexFor(new Date(Date.now() + offset * 86_400_000))];
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init().catch((err) => {
  $('dateline').textContent = 'Could not load the collection.';
  console.error(err);
});
