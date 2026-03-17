// Slope angle shading overlay — client-side computation
//
// Computes slope angle from terrain-RGB elevation tiles (AWS Terrarium format).
// For each tile:
// 1. Fetch the elevation-encoded RGB tile
// 2. Decode elevation: elevation = (R * 256 + G + B / 256) - 32768
// 3. Compute slope using Horn's method on 3x3 pixel neighborhoods
// 4. Map slope angles to standard avalanche terrain color bands:
//    - Transparent: < 20° (flat/gentle terrain)
//    - Green:  20–25°
//    - Yellow: 25–30°
//    - Orange: 30–35°
//    - Red:    35–45°
//    - Purple: > 45°

import { getMap } from './map.js';

const SLOPE_SOURCE_ID = 'slope-source';
const SLOPE_LAYER_ID = 'slope-layer';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

let slopeVisible = false;
let slopeOpacity = 0.55;

// Color ramp: [maxAngle, R, G, B, A]
// Transparent below 20°, then green → yellow → orange → red → purple
const COLOR_RAMP = [
  [20,  0,   0,   0,   0],     // < 20°: transparent
  [25,  74,  222, 128, 180],   // 20–25°: green
  [30,  250, 204, 21,  200],   // 25–30°: yellow
  [35,  249, 115, 22,  220],   // 30–35°: orange
  [45,  239, 68,  68,  230],   // 35–45°: red
  [90,  124, 58,  237, 240],   // > 45°: purple
];

export function initSlope() {
  const map = getMap();

  // Register custom protocol to transform terrain tiles into slope-colored tiles
  maplibregl.addProtocol('slope', (params, abortController) => {
    // Parse tile coords from the URL: slope://{z}/{x}/{y}
    const parts = params.url.replace('slope://', '').split('/');
    const z = parseInt(parts[0]);
    const x = parseInt(parts[1]);
    const y = parseInt(parts[2]);

    const terrainUrl = TERRAIN_TILES
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y);

    return fetch(terrainUrl, { signal: abortController.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Terrain tile fetch failed: ${response.status}`);
        return response.blob();
      })
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        const canvas = new OffscreenCanvas(256, 256);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, 256, 256);

        // Decode elevations from Terrarium encoding
        const elevations = decodeTerrarium(imageData.data, 256, 256);

        // Compute ground distance per pixel (meters)
        const cellSize = metersPerPixel(z, tileLatCenter(y, z));

        // Compute slope angles and apply color ramp
        const slopeData = computeSlopeColors(elevations, 256, 256, cellSize);

        // Write colored slope data back to canvas
        ctx.putImageData(new ImageData(slopeData, 256, 256), 0, 0);

        return canvas.convertToBlob({ type: 'image/png' });
      })
      .then(blob => blob.arrayBuffer())
      .then(data => ({ data }));
  });

  // Add slope tile source using custom protocol
  map.addSource(SLOPE_SOURCE_ID, {
    type: 'raster',
    tiles: ['slope://{z}/{x}/{y}'],
    tileSize: 256,
    maxzoom: 15,
    minzoom: 8,
  });

  createSlopeControls();
  initDebugTap();
}

// Decode Terrarium RGB → elevation in meters
// Formula: elevation = (R * 256 + G + B / 256) - 32768
function decodeTerrarium(pixels, width, height) {
  const elevations = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    elevations[i] = (r * 256 + g + b / 256) - 32768;
  }
  return elevations;
}

// Compute slope angle in degrees using Horn's method (3x3 kernel)
// Returns RGBA pixel data with slope-colored output
function computeSlopeColors(elevations, width, height, cellSize) {
  const output = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;

      // Clamp edges — use nearest neighbor for boundary pixels
      const r0 = Math.max(0, row - 1);
      const r2 = Math.min(height - 1, row + 1);
      const c0 = Math.max(0, col - 1);
      const c2 = Math.min(width - 1, col + 1);

      // Horn's method: weighted gradient from 3x3 neighborhood
      // a b c
      // d e f
      // g h i
      const a = elevations[r0 * width + c0];
      const b = elevations[r0 * width + col];
      const c = elevations[r0 * width + c2];
      const d = elevations[row * width + c0];
      // e = center (not used in gradient)
      const f = elevations[row * width + c2];
      const g = elevations[r2 * width + c0];
      const h = elevations[r2 * width + col];
      const i = elevations[r2 * width + c2];

      const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cellSize);
      const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cellSize);

      const slopeDeg = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);

      // Apply color ramp
      const outIdx = idx * 4;
      let applied = false;
      for (const [maxAngle, r, g, b, alpha] of COLOR_RAMP) {
        if (slopeDeg < maxAngle) {
          output[outIdx] = r;
          output[outIdx + 1] = g;
          output[outIdx + 2] = b;
          output[outIdx + 3] = alpha;
          applied = true;
          break;
        }
      }
      if (!applied) {
        // > 45° — use purple
        output[outIdx] = 124;
        output[outIdx + 1] = 58;
        output[outIdx + 2] = 237;
        output[outIdx + 3] = 240;
      }
    }
  }

  return output;
}

// Calculate meters per pixel at a given zoom level and latitude
function metersPerPixel(zoom, lat) {
  return (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom);
}

// Get the latitude at the center of a tile
function tileLatCenter(y, z) {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function addSlopeLayer() {
  const map = getMap();
  if (map.getLayer(SLOPE_LAYER_ID)) return;

  map.addLayer({
    id: SLOPE_LAYER_ID,
    type: 'raster',
    source: SLOPE_SOURCE_ID,
    paint: {
      'raster-opacity': slopeOpacity,
    },
  });
}

function removeSlopeLayer() {
  const map = getMap();
  if (map.getLayer(SLOPE_LAYER_ID)) {
    map.removeLayer(SLOPE_LAYER_ID);
  }
}

export function toggleSlope() {
  slopeVisible = !slopeVisible;
  if (slopeVisible) {
    addSlopeLayer();
  } else {
    removeSlopeLayer();
  }
  return slopeVisible;
}

export function setSlopeOpacity(opacity) {
  slopeOpacity = opacity;
  const map = getMap();
  if (map.getLayer(SLOPE_LAYER_ID)) {
    map.setPaintProperty(SLOPE_LAYER_ID, 'raster-opacity', opacity);
  }
}

export function isSlopeVisible() {
  return slopeVisible;
}

// Debug: tap map to log slope angle at that point
function initDebugTap() {
  const map = getMap();

  map.on('click', (e) => {
    if (!slopeVisible) return;

    const { lng, lat } = e.lngLat;
    const zoom = Math.floor(map.getZoom());

    // Calculate which terrain tile contains this point
    const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
    const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));

    // Fetch the terrain tile and compute slope at the clicked point
    const terrainUrl = TERRAIN_TILES
      .replace('{z}', zoom)
      .replace('{x}', tileX)
      .replace('{y}', tileY);

    fetch(terrainUrl)
      .then(r => r.blob())
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        const canvas = new OffscreenCanvas(256, 256);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, 256, 256);

        // Find pixel position within tile
        const n = Math.pow(2, zoom);
        const tileLeft = tileX / n * 360 - 180;
        const tileRight = (tileX + 1) / n * 360 - 180;
        const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n)));
        const latRadNext = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + 1) / n)));
        const tileTop = latRad * 180 / Math.PI;
        const tileBottom = latRadNext * 180 / Math.PI;

        const px = Math.floor((lng - tileLeft) / (tileRight - tileLeft) * 256);
        const py = Math.floor((tileTop - lat) / (tileTop - tileBottom) * 256);

        const clampX = Math.max(1, Math.min(254, px));
        const clampY = Math.max(1, Math.min(254, py));

        // Decode elevations for 3x3 neighborhood
        const cellSize = metersPerPixel(zoom, lat);
        const getEle = (col, row) => {
          const i = (row * 256 + col) * 4;
          return (imageData.data[i] * 256 + imageData.data[i + 1] + imageData.data[i + 2] / 256) - 32768;
        };

        const elevation = getEle(clampX, clampY);

        // Horn's method
        const a = getEle(clampX - 1, clampY - 1);
        const b = getEle(clampX, clampY - 1);
        const c = getEle(clampX + 1, clampY - 1);
        const d = getEle(clampX - 1, clampY);
        const f = getEle(clampX + 1, clampY);
        const g = getEle(clampX - 1, clampY + 1);
        const h = getEle(clampX, clampY + 1);
        const i = getEle(clampX + 1, clampY + 1);

        const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cellSize);
        const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cellSize);
        const slopeDeg = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);

        console.log(
          `[Slope Debug] lat=${lat.toFixed(5)}, lng=${lng.toFixed(5)} | ` +
          `elevation=${elevation.toFixed(1)}m | slope=${slopeDeg.toFixed(1)}° | ` +
          `zoom=${zoom} | tile=(${tileX},${tileY}) px=(${clampX},${clampY})`
        );
      })
      .catch(err => {
        console.warn('[Slope Debug] Failed to fetch terrain tile:', err.message);
      });
  });
}

function createSlopeControls() {
  // Slope toggle button
  const slopeControl = document.createElement('div');
  slopeControl.className = 'map-control top-left-slope';
  slopeControl.innerHTML = `
    <button id="slope-btn" class="control-btn" title="Slope angle shading">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M2 20 L22 20 L2 6 Z"/>
        <line x1="8" y1="20" x2="8" y2="13" stroke-dasharray="2,2" opacity="0.5"/>
        <line x1="14" y1="20" x2="14" y2="9" stroke-dasharray="2,2" opacity="0.5"/>
      </svg>
    </button>
    <div id="slope-panel" class="slope-panel hidden">
      <div class="slope-panel-header">Slope Angle</div>
      <div class="slope-opacity-control">
        <label class="slope-opacity-label">Opacity</label>
        <input type="range" id="slope-opacity" min="10" max="100" value="55" class="slope-slider">
      </div>
      <div class="slope-legend">
        <div class="legend-item"><span class="legend-color" style="background:#4ade80"></span>20–25°</div>
        <div class="legend-item"><span class="legend-color" style="background:#facc15"></span>25–30°</div>
        <div class="legend-item"><span class="legend-color" style="background:#f97316"></span>30–35°</div>
        <div class="legend-item"><span class="legend-color" style="background:#ef4444"></span>35–45°</div>
        <div class="legend-item"><span class="legend-color" style="background:#7c3aed"></span>&gt; 45°</div>
      </div>
      <div class="slope-debug-hint" style="margin-top:8px;font-size:9px;color:#666;font-family:var(--font-mono)">
        Tap map to log slope°
      </div>
    </div>
  `;
  document.body.appendChild(slopeControl);

  const btn = document.getElementById('slope-btn');
  const panel = document.getElementById('slope-panel');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const visible = toggleSlope();
    btn.classList.toggle('active', visible);

    if (visible) {
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  });

  document.getElementById('slope-opacity').addEventListener('input', (e) => {
    setSlopeOpacity(parseInt(e.target.value) / 100);
  });
}
