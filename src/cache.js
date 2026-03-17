// Offline tile caching — region selector, batch downloader, cache manager
//
// Strategy: User draws a bounding box on the map, selects zoom levels,
// previews tile count, then downloads tiles in batches into IndexedDB.
// The service worker intercepts tile requests and serves cached tiles when offline.

import { getMap, getCurrentLayer } from './map.js';

const TILE_STORE = 'tile-cache';
const REGION_STORE = 'cached-regions';
const DB_NAME = 'trailmap-tiles';
const DB_VERSION = 1;

let tileDB = null;

const TILE_SOURCES = {
  topo: {
    urlTemplate: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
  },
  satellite: {
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
  },
  slope: {
    urlTemplate: 'https://caltopo.com/tile/sf/{z}/{x}/{y}.png',
    maxZoom: 16,
  },
};

// Open dedicated tile database (separate from main app DB to avoid bloat)
async function openTileDB() {
  if (tileDB) return tileDB;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(TILE_STORE)) {
        db.createObjectStore(TILE_STORE, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(REGION_STORE)) {
        db.createObjectStore(REGION_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      tileDB = event.target.result;
      resolve(tileDB);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

// Calculate tile coordinates for a bounding box at a given zoom level
function getTilesForBounds(bounds, zoom) {
  const tiles = [];
  const minTileX = lon2tile(bounds.west, zoom);
  const maxTileX = lon2tile(bounds.east, zoom);
  const minTileY = lat2tile(bounds.north, zoom); // Note: y is inverted
  const maxTileY = lat2tile(bounds.south, zoom);

  for (let x = minTileX; x <= maxTileX; x++) {
    for (let y = minTileY; y <= maxTileY; y++) {
      tiles.push({ x, y, z: zoom });
    }
  }
  return tiles;
}

function lon2tile(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function lat2tile(lat, zoom) {
  return Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
}

// Estimate tile count and storage for given bounds and zoom range
export function estimateTiles(bounds, minZoom, maxZoom, layerTypes) {
  let totalTiles = 0;

  for (let z = minZoom; z <= maxZoom; z++) {
    const tiles = getTilesForBounds(bounds, z);
    totalTiles += tiles.length * layerTypes.length;
  }

  // Average tile size ~20KB for raster tiles
  const estimatedSizeMB = (totalTiles * 20) / 1024;

  return { totalTiles, estimatedSizeMB };
}

// Download tiles for a region
export async function downloadRegion(regionId, name, bounds, minZoom, maxZoom, layerTypes, onProgress) {
  const db = await openTileDB();
  let downloaded = 0;
  let failed = 0;
  let total = 0;

  // Count total tiles
  const allTiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const tiles = getTilesForBounds(bounds, z);
    for (const tile of tiles) {
      for (const layerType of layerTypes) {
        const source = TILE_SOURCES[layerType];
        if (!source || z > source.maxZoom) continue;
        const url = source.urlTemplate
          .replace('{z}', tile.z)
          .replace('{x}', tile.x)
          .replace('{y}', tile.y);
        allTiles.push({ url, tile, layerType });
        total++;
      }
    }
  }

  if (onProgress) onProgress({ downloaded: 0, failed: 0, total, phase: 'downloading' });

  // Download in batches of 20 concurrent requests
  const BATCH_SIZE = 20;
  for (let i = 0; i < allTiles.length; i += BATCH_SIZE) {
    const batch = allTiles.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async ({ url }) => {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();

          const tx = db.transaction(TILE_STORE, 'readwrite');
          tx.objectStore(TILE_STORE).put({
            url,
            data: arrayBuffer,
            contentType: blob.type,
            timestamp: Date.now(),
          });

          downloaded++;
        } catch (err) {
          failed++;
        }

        if (onProgress) {
          onProgress({ downloaded, failed, total, phase: 'downloading' });
        }
      })
    );
  }

  // Save region metadata
  const region = {
    id: regionId,
    name,
    bounds,
    minZoom,
    maxZoom,
    layerTypes,
    tileCount: downloaded,
    estimatedSizeMB: (downloaded * 20) / 1024,
    createdAt: new Date().toISOString(),
  };

  const tx = db.transaction(REGION_STORE, 'readwrite');
  tx.objectStore(REGION_STORE).put(region);

  if (onProgress) onProgress({ downloaded, failed, total, phase: 'complete' });

  return region;
}

// Get all cached regions
export async function getCachedRegions() {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGION_STORE, 'readonly');
    const request = tx.objectStore(REGION_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

// Delete a cached region and its tiles
export async function deleteRegion(regionId) {
  const db = await openTileDB();

  // Get region info
  const region = await new Promise((resolve, reject) => {
    const tx = db.transaction(REGION_STORE, 'readonly');
    const request = tx.objectStore(REGION_STORE).get(regionId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });

  if (!region) return;

  // Delete tiles for this region's bounds/zoom levels
  for (let z = region.minZoom; z <= region.maxZoom; z++) {
    const tiles = getTilesForBounds(region.bounds, z);
    for (const tile of tiles) {
      for (const layerType of region.layerTypes) {
        const source = TILE_SOURCES[layerType];
        if (!source || z > source.maxZoom) continue;
        const url = source.urlTemplate
          .replace('{z}', tile.z)
          .replace('{x}', tile.x)
          .replace('{y}', tile.y);

        const tx = db.transaction(TILE_STORE, 'readwrite');
        tx.objectStore(TILE_STORE).delete(url);
      }
    }
  }

  // Delete region record
  const tx = db.transaction(REGION_STORE, 'readwrite');
  tx.objectStore(REGION_STORE).delete(regionId);
}

// Get a cached tile by URL (used by service worker via message passing)
export async function getCachedTile(url) {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TILE_STORE, 'readonly');
    const request = tx.objectStore(TILE_STORE).get(url);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = (e) => reject(e.target.error);
  });
}

// Initialize cache UI
export function initCacheUI() {
  createCacheButton();
}

function createCacheButton() {
  const cacheControl = document.createElement('div');
  cacheControl.className = 'map-control top-left-cache';
  cacheControl.innerHTML = `
    <button id="cache-btn" class="control-btn" title="Offline cache">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    </button>
  `;
  document.body.appendChild(cacheControl);

  document.getElementById('cache-btn').addEventListener('click', () => {
    showCachePanel();
  });
}

let cachePanel = null;
let drawingRegion = false;
let regionBounds = null;
let regionRect = null;

function showCachePanel() {
  if (cachePanel) {
    cachePanel.classList.toggle('open');
    return;
  }

  cachePanel = document.createElement('div');
  cachePanel.className = 'bottom-sheet open';
  cachePanel.id = 'cache-panel';
  cachePanel.innerHTML = `
    <div class="bottom-sheet-handle"></div>
    <div class="route-info-content">
      <div class="route-header">
        <h3 class="route-title">Offline Cache</h3>
        <button id="close-cache-panel" class="panel-close-btn">&times;</button>
      </div>

      <div id="cache-draw-section">
        <button id="draw-region-btn" class="cache-action-btn">Draw Region on Map</button>
        <div id="region-config" class="hidden">
          <div class="cache-field">
            <label>Region Name</label>
            <input type="text" id="region-name" class="cache-input" value="New Region" />
          </div>
          <div class="cache-field">
            <label>Zoom Range</label>
            <div class="zoom-range">
              <select id="min-zoom" class="cache-select"></select>
              <span class="zoom-dash">–</span>
              <select id="max-zoom" class="cache-select"></select>
            </div>
          </div>
          <div class="cache-field">
            <label>Layers</label>
            <div class="cache-layers">
              <label class="cache-checkbox"><input type="checkbox" value="topo" checked> Topo</label>
              <label class="cache-checkbox"><input type="checkbox" value="satellite"> Satellite</label>
              <label class="cache-checkbox"><input type="checkbox" value="slope"> Slope</label>
            </div>
          </div>
          <div id="tile-estimate" class="tile-estimate"></div>
          <button id="start-download-btn" class="cache-action-btn accent">Download Tiles</button>
        </div>
        <div id="download-progress" class="hidden">
          <div class="progress-bar-container">
            <div class="progress-bar" id="cache-progress-bar"></div>
          </div>
          <div id="cache-progress-text" class="progress-text"></div>
        </div>
      </div>

      <div id="cached-regions-section">
        <h4 class="section-title">Cached Regions</h4>
        <div id="cached-regions-list"></div>
      </div>
    </div>
  `;
  document.body.appendChild(cachePanel);

  // Populate zoom selects
  const minSelect = document.getElementById('min-zoom');
  const maxSelect = document.getElementById('max-zoom');
  for (let z = 6; z <= 17; z++) {
    minSelect.add(new Option(`z${z}`, z));
    maxSelect.add(new Option(`z${z}`, z));
  }
  minSelect.value = '8';
  maxSelect.value = '15';

  document.getElementById('close-cache-panel').addEventListener('click', () => {
    cachePanel.classList.remove('open');
    cancelDrawing();
  });

  document.getElementById('draw-region-btn').addEventListener('click', () => {
    startDrawingRegion();
  });

  document.getElementById('start-download-btn').addEventListener('click', () => {
    startDownload();
  });

  // Update estimate when config changes
  const updateEstimate = () => {
    if (!regionBounds) return;
    const minZ = parseInt(document.getElementById('min-zoom').value);
    const maxZ = parseInt(document.getElementById('max-zoom').value);
    const layers = getSelectedLayers();
    const est = estimateTiles(regionBounds, minZ, maxZ, layers);
    document.getElementById('tile-estimate').textContent =
      `${est.totalTiles.toLocaleString()} tiles · ~${est.estimatedSizeMB.toFixed(0)} MB`;
  };

  minSelect.addEventListener('change', updateEstimate);
  maxSelect.addEventListener('change', updateEstimate);
  cachePanel.querySelectorAll('.cache-layers input').forEach((cb) => {
    cb.addEventListener('change', updateEstimate);
  });

  loadCachedRegions();
}

function getSelectedLayers() {
  return [...document.querySelectorAll('.cache-layers input:checked')].map((cb) => cb.value);
}

function startDrawingRegion() {
  const map = getMap();
  drawingRegion = true;
  document.getElementById('draw-region-btn').textContent = 'Click two corners on the map...';
  map.getCanvas().style.cursor = 'crosshair';

  let clicks = [];

  const onClick = (e) => {
    clicks.push(e.lngLat);

    if (clicks.length === 1) {
      document.getElementById('draw-region-btn').textContent = 'Click second corner...';
    }

    if (clicks.length === 2) {
      map.off('click', onClick);
      map.getCanvas().style.cursor = '';
      drawingRegion = false;

      regionBounds = {
        west: Math.min(clicks[0].lng, clicks[1].lng),
        east: Math.max(clicks[0].lng, clicks[1].lng),
        north: Math.max(clicks[0].lat, clicks[1].lat),
        south: Math.min(clicks[0].lat, clicks[1].lat),
      };

      // Draw rectangle on map
      drawRegionRect(regionBounds);

      document.getElementById('draw-region-btn').textContent = 'Redraw Region';
      document.getElementById('region-config').classList.remove('hidden');

      // Calculate estimate
      const minZ = parseInt(document.getElementById('min-zoom').value);
      const maxZ = parseInt(document.getElementById('max-zoom').value);
      const layers = getSelectedLayers();
      const est = estimateTiles(regionBounds, minZ, maxZ, layers);
      document.getElementById('tile-estimate').textContent =
        `${est.totalTiles.toLocaleString()} tiles · ~${est.estimatedSizeMB.toFixed(0)} MB`;
    }
  };

  map.on('click', onClick);
}

function drawRegionRect(bounds) {
  const map = getMap();

  const data = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [bounds.west, bounds.north],
        [bounds.east, bounds.north],
        [bounds.east, bounds.south],
        [bounds.west, bounds.south],
        [bounds.west, bounds.north],
      ]],
    },
  };

  if (map.getSource('region-rect')) {
    map.getSource('region-rect').setData(data);
  } else {
    map.addSource('region-rect', { type: 'geojson', data });
    map.addLayer({
      id: 'region-rect-fill',
      type: 'fill',
      source: 'region-rect',
      paint: { 'fill-color': '#d97706', 'fill-opacity': 0.1 },
    });
    map.addLayer({
      id: 'region-rect-outline',
      type: 'line',
      source: 'region-rect',
      paint: { 'line-color': '#d97706', 'line-width': 2, 'line-dasharray': [4, 4] },
    });
  }
}

function cancelDrawing() {
  const map = getMap();
  drawingRegion = false;
  map.getCanvas().style.cursor = '';

  if (map.getLayer('region-rect-fill')) map.removeLayer('region-rect-fill');
  if (map.getLayer('region-rect-outline')) map.removeLayer('region-rect-outline');
  if (map.getSource('region-rect')) map.removeSource('region-rect');
}

async function startDownload() {
  if (!regionBounds) return;

  const name = document.getElementById('region-name').value || 'Unnamed Region';
  const minZ = parseInt(document.getElementById('min-zoom').value);
  const maxZ = parseInt(document.getElementById('max-zoom').value);
  const layers = getSelectedLayers();
  const regionId = crypto.randomUUID();

  document.getElementById('region-config').classList.add('hidden');
  document.getElementById('download-progress').classList.remove('hidden');

  await downloadRegion(regionId, name, regionBounds, minZ, maxZ, layers, (progress) => {
    const pct = progress.total > 0 ? (progress.downloaded / progress.total) * 100 : 0;
    document.getElementById('cache-progress-bar').style.width = `${pct}%`;
    document.getElementById('cache-progress-text').textContent =
      `${progress.downloaded.toLocaleString()} / ${progress.total.toLocaleString()} tiles` +
      (progress.failed > 0 ? ` (${progress.failed} failed)` : '');

    if (progress.phase === 'complete') {
      document.getElementById('cache-progress-text').textContent += ' — Done!';
      cancelDrawing();
      loadCachedRegions();

      // Reset UI after delay
      setTimeout(() => {
        document.getElementById('download-progress').classList.add('hidden');
        document.getElementById('region-config').classList.remove('hidden');
        document.getElementById('cache-progress-bar').style.width = '0%';
      }, 2000);
    }
  });
}

async function loadCachedRegions() {
  const regions = await getCachedRegions();
  const container = document.getElementById('cached-regions-list');
  if (!container) return;

  if (regions.length === 0) {
    container.innerHTML = '<div class="empty-state">No cached regions</div>';
    return;
  }

  container.innerHTML = regions
    .map(
      (r) => `
    <div class="cached-region" data-id="${r.id}">
      <div class="cached-region-info">
        <div class="cached-region-name">${r.name}</div>
        <div class="cached-region-meta">${r.tileCount.toLocaleString()} tiles · ~${r.estimatedSizeMB.toFixed(0)} MB · ${r.layerTypes.join(', ')}</div>
      </div>
      <button class="delete-region-btn" data-id="${r.id}" title="Delete">&times;</button>
    </div>
  `
    )
    .join('');

  container.querySelectorAll('.delete-region-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await deleteRegion(id);
      loadCachedRegions();
    });
  });
}
