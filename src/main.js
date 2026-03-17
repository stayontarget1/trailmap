// App entry point
import { initMap } from './map.js';
import { initUI } from './ui.js';
import { openDB } from './db.js';

async function init() {
  await openDB();
  initMap();
  initUI();
}

init();

// Register service worker for PWA/offline support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
}
