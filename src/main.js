// App entry point
import { initMap } from './map.js';

const map = initMap();

// Register service worker for PWA/offline support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
}
