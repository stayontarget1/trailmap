// App entry point
import { initMap, getMap } from './map.js';
import { initUI } from './ui.js';
import { openDB } from './db.js';
import { initSlope } from './slope.js';
import { initCacheUI } from './cache.js';

async function init() {
  await openDB();
  const map = initMap();
  initUI();
  initCacheUI();

  // Init slope angle shading after map loads (needs sources ready)
  map.on('load', () => {
    initSlope();
  });
}

init();

// Register service worker for PWA/offline support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
}
