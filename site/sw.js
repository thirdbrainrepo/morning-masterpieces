// Service worker: cache-first app shell, network-first manifest,
// runtime-cached artwork images (capped).

const VERSION = 'mm-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest'];
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

  // Manifest: network-first so a new rotation lands promptly.
  if (url.pathname.endsWith('artworks.json') || url.pathname.endsWith('today.json')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Images: cache-first with a capped runtime cache.
  if (url.pathname.includes('/images/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(IMAGE_CACHE).then((c) => {
              c.put(event.request, copy);
              trimCache(IMAGE_CACHE, IMAGE_LIMIT);
            });
            return res;
          })
      )
    );
    return;
  }

  // Shell: cache-first.
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
