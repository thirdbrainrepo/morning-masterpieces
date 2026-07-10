// Service worker: network-first app shell and manifest (always fresh online,
// cached copy as offline fallback), cache-first artwork images (capped).
//
// The shell is deliberately NOT cache-first: this site deploys silently in
// the background (daily CI, occasional layout fixes), and a cache-first
// shell would pin every installed PWA to whatever version it first saw.
//
// BUMP VERSION whenever committed media bytes change under stable URLs
// (e.g. a --force recomposition of wallpapers). Media is cache-first, so
// installed PWAs keep serving the old bytes until the image cache is
// renamed away by a version bump.

const VERSION = 'mm-v9';
const SHELL = ['./', 'index.html', 'shortcuts.html', 'styles.css', 'app.js', 'manifest.webmanifest'];
const IMAGE_CACHE = `${VERSION}-images`;
const IMAGE_LIMIT = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![VERSION, IMAGE_CACHE].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > limit) await cache.delete(keys[0]);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  // Artwork images and narration: cache-first with a capped runtime cache.
  // These are content-stable between version bumps. NOT /today/ — those
  // change content daily under one URL.
  if (url.pathname.includes('/images/') || url.pathname.includes('/audio/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            // Never cache failures: a 404 cached under a stable media URL
            // (e.g. narration rendered a day late) would stick forever.
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(
                caches.open(IMAGE_CACHE).then((c) =>
                  c.put(event.request, copy).then(() => trimCache(IMAGE_CACHE, IMAGE_LIMIT))
                )
              );
            }
            return res;
          })
      )
    );
    return;
  }

  // Everything else (shell, artworks.json, today.json): network-first,
  // falling back to the last cached copy when offline. Navigations fall
  // back to the cached shell so deep links like /?view=full work offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(VERSION).then((c) => c.put(event.request, copy)));
        }
        return res;
      })
      .catch(async () =>
        (await caches.match(event.request)) ??
        (event.request.mode === 'navigate' ? caches.match('index.html') : undefined)
      )
  );
});
