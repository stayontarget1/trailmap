// Slope angle shading overlay
//
// Approach: Uses CalTopo's pre-rendered slope angle tiles as a raster overlay.
// CalTopo publishes slope-shaded tiles computed from USGS DEM data. These tiles
// use the standard avalanche terrain classification color bands:
//   - Green:  < 25°
//   - Yellow: 25–30°
//   - Orange: 30–35°
//   - Red:    35–45°
//   - Black/Purple: > 45°
//
// Why this approach:
// - Pre-rendered tiles are fast and require no client-side DEM processing
// - No large GeoTIFF downloads needed
// - Tiles are free and don't require an API key
// - CalTopo is the industry standard for slope angle shading in the backcountry community
//
// Fallback (Option B): If CalTopo tiles become unavailable, an alternative would be
// to download USGS 1/3 arc-second DEM GeoTIFFs and compute slope from elevation
// gradients client-side using a Sobel or Horn algorithm. This would require:
// 1. A build script to download DEM tiles for target regions
// 2. Client-side slope calculation per tile (computationally expensive)
// 3. Color-mapping slope angles to the standard bands
// This fallback is documented but not implemented unless CalTopo tiles prove unreliable.

import { getMap } from './map.js';

const SLOPE_SOURCE_ID = 'slope-source';
const SLOPE_LAYER_ID = 'slope-layer';

let slopeVisible = false;
let slopeOpacity = 0.45;

export function initSlope() {
  const map = getMap();

  // Add slope angle tile source
  // CalTopo slope angle shading tiles
  map.addSource(SLOPE_SOURCE_ID, {
    type: 'raster',
    tiles: [
      'https://caltopo.com/tile/sf/{z}/{x}/{y}.png'
    ],
    tileSize: 256,
    maxzoom: 16,
    attribution: '© CalTopo',
  });

  createSlopeControls();
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
        <input type="range" id="slope-opacity" min="10" max="80" value="45" class="slope-slider">
      </div>
      <div class="slope-legend">
        <div class="legend-item"><span class="legend-color" style="background:#4ade80"></span>&lt; 25°</div>
        <div class="legend-item"><span class="legend-color" style="background:#facc15"></span>25–30°</div>
        <div class="legend-item"><span class="legend-color" style="background:#f97316"></span>30–35°</div>
        <div class="legend-item"><span class="legend-color" style="background:#ef4444"></span>35–45°</div>
        <div class="legend-item"><span class="legend-color" style="background:#7c3aed"></span>&gt; 45°</div>
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

  // Close panel on outside click
  document.addEventListener('click', (e) => {
    if (!slopeControl.contains(e.target)) {
      // Don't hide panel if slope is active
    }
  });
}
