// Lets the web app open and run with no internet, after one visit. It keeps a copy of the app (its pages,
// scripts, the database engine and images) and serves it when the network is down. Data calls (/api/...)
// always go to the network: the app itself queues work and syncs later.
// __BUILD__ is replaced at build time (scripts/make-offline-manifest.js), so each deploy installs a fresh copy.
const VERSION = '__BUILD__';
const CACHE = `karya-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.add(new Request('/', { cache: 'reload' })); // the app's page
    try {
      // Every script and asset the build produced, so screens not yet visited also work offline.
      const list = await (await fetch('/precache.json', { cache: 'no-store' })).json();
      await Promise.all(list.files.map((file) => cache.add(new Request(file)).catch(() => {})));
    } catch (e) {
      // Offline copies will fill in as the app is used instead.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('karya-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // data: network only

  if (request.mode === 'navigate') {
    // Pages: the live one when online (so a new deploy shows up), the saved copy when not.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(async () => (await caches.match('/')) || Response.error()),
    );
    return;
  }

  // Scripts, images, the database engine: file names change with every build, so a saved copy is always right.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
