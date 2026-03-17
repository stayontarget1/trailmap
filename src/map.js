// Map setup, layers, and controls

const LAYERS = {
  topo: {
    type: 'raster',
    tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    attribution: '© OpenTopoMap',
    maxzoom: 17,
  },
  satellite: {
    type: 'raster',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    ],
    tileSize: 256,
    attribution: '© Esri',
    maxzoom: 19,
  },
};

// CartoDB Positron labels-only — transparent background with geographic labels
// (peaks, lakes, roads, towns, etc.) for use on top of satellite/hybrid
const LABELS_TILES = [
  'https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png'
];

let map;
let currentLayer = 'topo';
let followMode = false;
let lastGpsLngLat = null;

export function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        'topo-source': {
          type: 'raster',
          tiles: LAYERS.topo.tiles,
          tileSize: LAYERS.topo.tileSize,
          maxzoom: LAYERS.topo.maxzoom,
          attribution: LAYERS.topo.attribution,
        },
      },
      layers: [
        {
          id: 'topo-layer',
          type: 'raster',
          source: 'topo-source',
        },
      ],
    },
    center: [-118.7, 36.5], // Sierra Nevada default
    zoom: 7,
    maxZoom: 19,
    attributionControl: false,
  });

  map.on('load', () => {
    // Pre-add satellite source
    map.addSource('satellite-source', {
      type: 'raster',
      tiles: LAYERS.satellite.tiles,
      tileSize: LAYERS.satellite.tileSize,
      maxzoom: LAYERS.satellite.maxzoom,
      attribution: LAYERS.satellite.attribution,
    });

    // Labels overlay source — CartoDB labels-only (transparent bg, text labels for
    // peaks, lakes, ridges, trails, roads, towns). Used on satellite and hybrid.
    map.addSource('labels-source', {
      type: 'raster',
      tiles: LABELS_TILES,
      tileSize: 256,
      maxzoom: 19,
    });

    // GPS dot as GeoJSON source + circle layer (WebGL, not DOM — no jitter on pinch-zoom)
    map.addSource('gps-dot', {
      type: 'geojson',
      data: { type: 'Point', coordinates: [0, 0] },
    });

    // Outer pulse ring
    map.addLayer({
      id: 'gps-dot-pulse',
      type: 'circle',
      source: 'gps-dot',
      paint: {
        'circle-radius': 18,
        'circle-color': '#d97706',
        'circle-opacity': 0.15,
        'circle-stroke-width': 0,
      },
    });

    // Inner dot
    map.addLayer({
      id: 'gps-dot-inner',
      type: 'circle',
      source: 'gps-dot',
      paint: {
        'circle-radius': 7,
        'circle-color': '#d97706',
        'circle-opacity': 1,
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
      },
    });

    // Hide GPS layers until we have a position
    map.setLayoutProperty('gps-dot-pulse', 'visibility', 'none');
    map.setLayoutProperty('gps-dot-inner', 'visibility', 'none');
  });

  // Disable follow mode on any user interaction (pan, pinch-zoom, rotate)
  map.on('dragstart', () => { setFollowMode(false); });
  map.on('touchstart', (e) => {
    // Multi-touch (pinch zoom) should disable follow
    if (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length > 1) {
      setFollowMode(false);
    }
  });
  // Also catch programmatic zoom from double-tap or buttons won't disable follow,
  // but user-initiated zoom gestures will
  map.on('zoomstart', (e) => {
    if (e.originalEvent) {
      // Only disable follow for user-initiated zooms (has originalEvent),
      // not our own flyTo calls
      setFollowMode(false);
    }
  });

  initControls();
  initScaleBar();
  initCoords();

  return map;
}

function initControls() {
  // Zoom
  document.getElementById('zoom-in').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => map.zoomOut());

  // Compass — reset bearing on click
  document.getElementById('compass-btn').addEventListener('click', () => {
    map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
  });

  // Update compass arrow rotation
  map.on('rotate', () => {
    const bearing = map.getBearing();
    document.getElementById('compass-arrow').style.transform = `rotate(${-bearing}deg)`;
  });

  // Layer switcher
  const layerBtn = document.getElementById('layer-btn');
  const layerMenu = document.getElementById('layer-menu');

  layerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    layerMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    layerMenu.classList.add('hidden');
  });

  document.querySelectorAll('.layer-option').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const layer = btn.dataset.layer;
      switchLayer(layer);
      document.querySelectorAll('.layer-option').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      layerMenu.classList.add('hidden');
    });
  });

  // Locate me — tap to fly to position and enable follow mode
  document.getElementById('locate-btn').addEventListener('click', () => {
    locateUser();
  });
}

function switchLayer(layer) {
  currentLayer = layer;

  // Remove existing base/label layers
  ['topo-layer', 'satellite-layer', 'labels-overlay'].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });

  // Find insertion point — add base layers below any route/GPS overlay layers
  const beforeLayer = getFirstOverlayLayer();

  if (layer === 'topo') {
    // Topo tiles have labels baked in — no separate labels layer needed
    map.addLayer({ id: 'topo-layer', type: 'raster', source: 'topo-source' }, beforeLayer);
  } else if (layer === 'satellite') {
    // Satellite + label overlay so peaks/lakes/roads are visible
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite-source' }, beforeLayer);
    map.addLayer({
      id: 'labels-overlay', type: 'raster', source: 'labels-source',
      paint: { 'raster-opacity': 1 },
    }, beforeLayer);
  } else if (layer === 'hybrid') {
    // Same as satellite — satellite base + labels on top
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite-source' }, beforeLayer);
    map.addLayer({
      id: 'labels-overlay', type: 'raster', source: 'labels-source',
      paint: { 'raster-opacity': 1 },
    }, beforeLayer);
  }
}

// Find the first non-base overlay layer (route lines, GPS dot, etc.)
// so base layers are inserted below them
function getFirstOverlayLayer() {
  const baseLayers = new Set(['topo-layer', 'satellite-layer', 'labels-overlay']);
  const layers = map.getStyle().layers;
  for (const layer of layers) {
    if (!baseLayers.has(layer.id)) return layer.id;
  }
  return undefined;
}

function locateUser() {
  const btn = document.getElementById('locate-btn');

  if (!navigator.geolocation) return;

  // If we already have a GPS position, fly there and enable follow
  if (lastGpsLngLat) {
    setFollowMode(true);
    map.flyTo({ center: lastGpsLngLat, zoom: Math.max(map.getZoom(), 15), duration: 1000 });
    return;
  }

  // First locate — request position
  btn.classList.add('active');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const lngLat = [longitude, latitude];

      showGpsPosition(longitude, latitude, accuracy);
      setFollowMode(true);
      map.flyTo({ center: lngLat, zoom: 15, duration: 1000 });
      btn.classList.remove('active');
    },
    (err) => {
      console.warn('Geolocation error:', err.message);
      btn.classList.remove('active');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// Update follow mode state and button appearance
function setFollowMode(enabled) {
  followMode = enabled;
  const btn = document.getElementById('locate-btn');
  btn.classList.toggle('active', enabled);
}

export function isFollowMode() {
  return followMode;
}

export function showGpsPosition(lng, lat, accuracy) {
  lastGpsLngLat = [lng, lat];

  // Accuracy circle as GeoJSON
  const circle = createCircle([lng, lat], accuracy);

  if (map.getSource('gps-accuracy')) {
    map.getSource('gps-accuracy').setData(circle);
  } else {
    map.addSource('gps-accuracy', { type: 'geojson', data: circle });
    map.addLayer({
      id: 'gps-accuracy-layer',
      type: 'fill',
      source: 'gps-accuracy',
      paint: {
        'fill-color': '#d97706',
        'fill-opacity': 0.1,
      },
    });
  }

  // Update GPS dot position (GeoJSON circle layer — rendered in WebGL, rock-solid during zoom)
  if (map.getSource('gps-dot')) {
    map.getSource('gps-dot').setData({ type: 'Point', coordinates: [lng, lat] });
    map.setLayoutProperty('gps-dot-pulse', 'visibility', 'visible');
    map.setLayoutProperty('gps-dot-inner', 'visibility', 'visible');
  }

  // If follow mode is on, keep map centered on GPS position
  if (followMode) {
    map.easeTo({ center: [lng, lat], duration: 500 });
  }
}

// Generate a GeoJSON circle polygon for accuracy display
function createCircle(center, radiusMeters, points = 64) {
  const coords = [];
  const earthRadius = 6371000;
  const lat = (center[1] * Math.PI) / 180;
  const lng = (center[0] * Math.PI) / 180;
  const d = radiusMeters / earthRadius;

  for (let i = 0; i <= points; i++) {
    const bearing = (2 * Math.PI * i) / points;
    const pLat = Math.asin(
      Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(bearing)
    );
    const pLng =
      lng +
      Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(lat),
        Math.cos(d) - Math.sin(lat) * Math.sin(pLat)
      );
    coords.push([(pLng * 180) / Math.PI, (pLat * 180) / Math.PI]);
  }

  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
  };
}

// Scale bar — updates on zoom/move
function initScaleBar() {
  const updateScale = () => {
    const center = map.getCenter();
    const zoom = map.getZoom();

    // Calculate meters per pixel at current center/zoom
    const metersPerPixel =
      (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, zoom);

    // Find a nice round distance for ~100px width
    const targetWidthPx = 100;
    const targetMeters = metersPerPixel * targetWidthPx;

    const { distance, unit, label } = getNiceScaleDistance(targetMeters);

    let distanceMeters = unit === 'km' ? distance * 1000 : unit === 'mi' ? distance * 1609.34 : unit === 'ft' ? distance * 0.3048 : distance;
    const widthPx = distanceMeters / metersPerPixel;

    document.getElementById('scale-line').style.width = `${widthPx}px`;
    document.getElementById('scale-label').textContent = label;
  };

  map.on('zoom', updateScale);
  map.on('move', updateScale);
  map.on('load', updateScale);
}

function getNiceScaleDistance(meters) {
  // Metric nice values
  const niceMetric = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];

  let best = niceMetric[0];
  for (const v of niceMetric) {
    if (Math.abs(v - meters) < Math.abs(best - meters)) best = v;
  }

  if (best >= 1000) {
    return { distance: best / 1000, unit: 'km', label: `${best / 1000} km` };
  }
  return { distance: best, unit: 'm', label: `${best} m` };
}

// Coordinates display — shows center coords
function initCoords() {
  const updateCoords = () => {
    const { lng, lat } = map.getCenter();
    document.getElementById('coords-text').textContent =
      `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  };

  map.on('move', updateCoords);
  map.on('load', updateCoords);
}

export function getMap() {
  return map;
}

export function getCurrentLayer() {
  return currentLayer;
}
