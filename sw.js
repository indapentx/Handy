// Keeps a copy of the app so it opens without internet (videos are local files anyway).
// Network first, so updates arrive right away; the copy is used when offline or slow.
const CACHE = 'handy-v3';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './srt.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const fromNetwork = fetch(request).then((response) => {
    if (response.status === 200) cache.put(request, response.clone()).catch(() => {});
    return response;
  });
  fromNetwork.catch(() => {}); // handled below
  try {
    return await Promise.race([
      fromNetwork,
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000)),
    ]);
  } catch {
    const cached = (await cache.match(request, { ignoreSearch: true }))
      || (request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    return cached || fromNetwork;
  }
}
