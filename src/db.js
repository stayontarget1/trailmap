// IndexedDB wrapper for persistent local storage
// Stores GPX files, route metadata, and cached tiles

const DB_NAME = 'trailmap';
const DB_VERSION = 1;

let db = null;

export function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // GPX routes store
      if (!database.objectStoreNames.contains('routes')) {
        const store = database.createObjectStore('routes', { keyPath: 'id' });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }

      // Tile cache store (for Phase 5)
      if (!database.objectStoreNames.contains('tiles')) {
        database.createObjectStore('tiles', { keyPath: 'url' });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

export async function saveRoute(route) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('routes', 'readwrite');
    tx.objectStore('routes').put(route);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getRoute(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('routes', 'readonly');
    const request = tx.objectStore('routes').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function getAllRoutes() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('routes', 'readonly');
    const request = tx.objectStore('routes').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteRoute(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('routes', 'readwrite');
    tx.objectStore('routes').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}
