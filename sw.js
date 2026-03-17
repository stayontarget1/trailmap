// Service worker for offline PWA support
// Handles app shell caching and tile serving from IndexedDB

const CACHE_NAME = 'trailmap-v3';
const APP_SHELL = [
  './',
  './index.html',
  './styles/main.css',
  './src/main.js',
  './src/map.js',
  './src/gpx.js',
  './src/gps.js',
  './src/slope.js',
  './src/cache.js',
  './src/db.js',
  './src/ui.js',
  './src/library.js',
  './manifest.json',
];

const TILE_DB_NAME = 'trailmap-tiles';
const TILE_STORE = 'tile-cache';

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

// Open IndexedDB tile cache from within the service worker
function openTileDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TILE_DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(TILE_STORE)) {
        db.createObjectStore(TILE_STORE, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains('cached-regions')) {
        db.createObjectStore('cached-regions', { keyPath: 'id' });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

// Get a cached tile from IndexedDB
async function getCachedTile(url) {
  try {
    const db = await openTileDB();
    return new Promise((resolve) => {
      const tx = db.transaction(TILE_STORE, 'readonly');
      const request = tx.objectStore(TILE_STORE).get(url);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// Check if a URL looks like a tile request
function isTileRequest(url) {
  return (
    url.includes('tile.opentopomap.org') ||
    url.includes('arcgisonline.com') ||
    url.includes('caltopo.com/tile')
  );
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Tile requests: try network first, fall back to IndexedDB cache
  if (isTileRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            // Opportunistically cache tiles we fetch online
            const responseClone = response.clone();
            openTileDB()
              .then((db) => {
                responseClone.arrayBuffer().then((data) => {
                  const tx = db.transaction(TILE_STORE, 'readwrite');
                  tx.objectStore(TILE_STORE).put({
                    url,
                    data,
                    contentType: response.headers.get('content-type') || 'image/png',
                    timestamp: Date.now(),
                  });
                });
              })
              .catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          // Network failed — try IndexedDB cache
          const cached = await getCachedTile(url);
          if (cached) {
            return new Response(cached.data, {
              headers: { 'Content-Type': cached.contentType || 'image/png' },
            });
          }
          // Return transparent 1x1 PNG as fallback
          return new Response(
            Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)),
            { headers: { 'Content-Type': 'image/png' } }
          );
        })
    );
    return;
  }

  // App shell: cache first, network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
