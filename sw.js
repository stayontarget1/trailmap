// Service worker for offline PWA support
// Phase 1: Basic app shell caching
// Phase 5 will add tile caching via IndexedDB interception

const CACHE_NAME = 'trailmap-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles/main.css',
  './src/main.js',
  './src/map.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For tile requests, try network first, fall back to cache
  if (url.pathname.includes('/tile/') || url.hostname.includes('tile.') || url.hostname.includes('arcgisonline')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        fetch(event.request)
          .then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          })
          .catch(() => cache.match(event.request))
      )
    );
    return;
  }

  // App shell: cache first, network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
