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
  // Labels overlay for hybrid mode
  labels: {
    type: 'raster',
    tiles: [
      'https://tile.opentopomap.org/{z}/{x}/{y}.png'
    ],
    tileSize: 256,
    maxzoom: 17,
  },
};

let map;
let currentLayer = 'topo';

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

    // Labels overlay source (roads/trails on top of satellite)
    map.addSource('labels-source', {
      type: 'raster',
      tiles: [
        'https://stamen-tiles.a.ssl.fastly.net/toner-lines/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      maxzoom: 17,
    });

    map.addSource('label-text-source', {
      type: 'raster',
      tiles: [
        'https://stamen-tiles.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      maxzoom: 17,
    });
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

  // Locate me
  document.getElementById('locate-btn').addEventListener('click', () => {
    locateUser();
  });
}

function switchLayer(layer) {
  currentLayer = layer;

  // Remove existing layers
  ['topo-layer', 'satellite-layer', 'labels-overlay', 'label-text-overlay'].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });

  if (layer === 'topo') {
    map.addLayer({ id: 'topo-layer', type: 'raster', source: 'topo-source' }, getFirstSymbolLayer());
  } else if (layer === 'satellite') {
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite-source' }, getFirstSymbolLayer());
  } else if (layer === 'hybrid') {
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite-source' }, getFirstSymbolLayer());
    map.addLayer({
      id: 'labels-overlay', type: 'raster', source: 'labels-source',
      paint: { 'raster-opacity': 0.6 },
    });
    map.addLayer({
      id: 'label-text-overlay', type: 'raster', source: 'label-text-source',
      paint: { 'raster-opacity': 0.8 },
    });
  }
}

function getFirstSymbolLayer() {
  const layers = map.getStyle().layers;
  for (const layer of layers) {
    if (layer.type === 'symbol') return layer.id;
  }
  return undefined;
}

function locateUser() {
  const btn = document.getElementById('locate-btn');
  btn.classList.add('active');

  if (!navigator.geolocation) {
    btn.classList.remove('active');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      map.flyTo({ center: [longitude, latitude], zoom: 15, duration: 1000 });

      // Show position marker
      showGpsPosition(longitude, latitude, accuracy);
      btn.classList.remove('active');
    },
    (err) => {
      console.warn('Geolocation error:', err.message);
      btn.classList.remove('active');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

export function showGpsPosition(lng, lat, accuracy) {
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

  // GPS dot marker
  if (!map._gpsDotMarker) {
    const el = document.createElement('div');
    el.className = 'gps-dot';

    const pulseEl = document.createElement('div');
    pulseEl.className = 'gps-dot-pulse';
    pulseEl.style.position = 'absolute';
    pulseEl.style.top = '0';
    pulseEl.style.left = '0';

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.appendChild(pulseEl);
    wrapper.appendChild(el);

    map._gpsDotMarker = new maplibregl.Marker({ element: wrapper })
      .setLngLat([lng, lat])
      .addTo(map);
  } else {
    map._gpsDotMarker.setLngLat([lng, lat]);
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
