// GPX parsing, route rendering, elevation profile, and waypoint display

import { getMap } from './map.js';
import { saveRoute } from './db.js';

let activeRoute = null;
let routeMarkers = [];

// Parse a GPX XML string into structured data
export function parseGPX(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid GPX file');

  // Extract route name from metadata or first track
  const metadata = doc.querySelector('metadata > name');
  const trkName = doc.querySelector('trk > name');
  const name = metadata?.textContent || trkName?.textContent || 'Unnamed Route';

  // Parse track points
  const trackpoints = [];
  const trkpts = doc.querySelectorAll('trkpt');
  trkpts.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const eleEl = pt.querySelector('ele');
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    const timeEl = pt.querySelector('time');
    const time = timeEl ? new Date(timeEl.textContent) : null;
    trackpoints.push({ lat, lon, ele, time });
  });

  // Also parse route points (<rtept>) if no track points
  if (trackpoints.length === 0) {
    const rtepts = doc.querySelectorAll('rtept');
    rtepts.forEach((pt) => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const eleEl = pt.querySelector('ele');
      const ele = eleEl ? parseFloat(eleEl.textContent) : null;
      trackpoints.push({ lat, lon, ele, time: null });
    });
  }

  // Parse waypoints
  const waypoints = [];
  const wpts = doc.querySelectorAll('wpt');
  wpts.forEach((wpt) => {
    const lat = parseFloat(wpt.getAttribute('lat'));
    const lon = parseFloat(wpt.getAttribute('lon'));
    const eleEl = wpt.querySelector('ele');
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    const nameEl = wpt.querySelector('name');
    const descEl = wpt.querySelector('desc');
    waypoints.push({
      lat,
      lon,
      ele,
      name: nameEl?.textContent || '',
      desc: descEl?.textContent || '',
    });
  });

  return { name, trackpoints, waypoints };
}

// Calculate route statistics
export function calcRouteStats(trackpoints) {
  let totalDist = 0;
  let totalGain = 0;
  let totalLoss = 0;
  let minEle = Infinity;
  let maxEle = -Infinity;
  const distances = [0]; // cumulative distance at each point

  for (let i = 0; i < trackpoints.length; i++) {
    const pt = trackpoints[i];

    if (pt.ele !== null) {
      if (pt.ele < minEle) minEle = pt.ele;
      if (pt.ele > maxEle) maxEle = pt.ele;
    }

    if (i > 0) {
      const prev = trackpoints[i - 1];
      const dist = haversine(prev.lat, prev.lon, pt.lat, pt.lon);
      totalDist += dist;

      if (pt.ele !== null && prev.ele !== null) {
        const eleDiff = pt.ele - prev.ele;
        if (eleDiff > 0) totalGain += eleDiff;
        else totalLoss += Math.abs(eleDiff);
      }
    }
    distances.push(totalDist);
  }

  return {
    totalDistance: totalDist,
    totalGain,
    totalLoss,
    minElevation: minEle === Infinity ? 0 : minEle,
    maxElevation: maxEle === -Infinity ? 0 : maxEle,
    distances,
  };
}

// Haversine distance in meters between two lat/lon points
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Render route on map
export function renderRoute(trackpoints, waypoints) {
  const map = getMap();

  clearRoute();

  const coordinates = trackpoints.map((pt) => [pt.lon, pt.lat]);

  // Add route line
  map.addSource('route', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
    },
  });

  // Route outline (wider, darker)
  map.addLayer({
    id: 'route-outline',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#000',
      'line-width': 6,
      'line-opacity': 0.4,
    },
  });

  // Route line
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#d97706',
      'line-width': 3,
    },
  });

  // Start marker
  if (coordinates.length > 0) {
    const startEl = createMarkerEl('S', '#22c55e');
    const startMarker = new maplibregl.Marker({ element: startEl })
      .setLngLat(coordinates[0])
      .addTo(map);
    routeMarkers.push(startMarker);

    // End marker
    const endEl = createMarkerEl('E', '#ef4444');
    const endMarker = new maplibregl.Marker({ element: endEl })
      .setLngLat(coordinates[coordinates.length - 1])
      .addTo(map);
    routeMarkers.push(endMarker);
  }

  // Waypoints
  waypoints.forEach((wpt) => {
    const el = createMarkerEl('W', '#3b82f6');
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([wpt.lon, wpt.lat])
      .addTo(map);

    if (wpt.name) {
      const popup = new maplibregl.Popup({ offset: 16, closeButton: false })
        .setHTML(`<div style="font-family:var(--font-mono);font-size:12px;color:#e5e5e5;background:#111;padding:4px 8px;border-radius:4px;">${escapeHTML(wpt.name)}</div>`);
      marker.setPopup(popup);
    }

    routeMarkers.push(marker);
  });

  // Fit map to route bounds
  const bounds = coordinates.reduce(
    (b, coord) => b.extend(coord),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
  );
  map.fitBounds(bounds, { padding: 60, duration: 500 });
}

function createMarkerEl(label, color) {
  const el = document.createElement('div');
  el.style.cssText = `
    width:24px;height:24px;border-radius:50%;background:${color};
    display:flex;align-items:center;justify-content:center;
    font-family:var(--font-mono);font-size:11px;font-weight:600;
    color:white;border:2px solid rgba(255,255,255,0.8);
    box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;
  `;
  el.textContent = label;
  return el;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function clearRoute() {
  const map = getMap();

  ['route-line', 'route-outline'].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  if (map.getSource('route')) map.removeSource('route');

  routeMarkers.forEach((m) => m.remove());
  routeMarkers = [];
}

// Draw elevation profile on a canvas element
export function drawElevationProfile(canvas, trackpoints, distances) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 16, right: 12, bottom: 28, left: 48 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  // Filter points with valid elevation
  const points = trackpoints
    .map((pt, i) => ({ dist: distances[i], ele: pt.ele }))
    .filter((p) => p.ele !== null);

  if (points.length < 2) return;

  const maxDist = points[points.length - 1].dist;
  const elevations = points.map((p) => p.ele);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const eleRange = maxEle - minEle || 1;

  // Background
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  const numGridLines = 4;
  for (let i = 0; i <= numGridLines; i++) {
    const y = padding.top + (plotH * i) / numGridLines;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
  }

  // Elevation fill
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top + plotH);
  points.forEach((p) => {
    const x = padding.left + (p.dist / maxDist) * plotW;
    const y = padding.top + plotH - ((p.ele - minEle) / eleRange) * plotH;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
  gradient.addColorStop(0, 'rgba(217,119,6,0.3)');
  gradient.addColorStop(1, 'rgba(217,119,6,0.02)');
  ctx.fillStyle = gradient;
  ctx.fill();

  // Elevation line
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = padding.left + (p.dist / maxDist) * plotW;
    const y = padding.top + plotH - ((p.ele - minEle) / eleRange) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = '#666';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';

  for (let i = 0; i <= numGridLines; i++) {
    const ele = minEle + (eleRange * (numGridLines - i)) / numGridLines;
    const y = padding.top + (plotH * i) / numGridLines;
    ctx.fillText(`${Math.round(metersToFeet(ele))}'`, padding.left - 4, y + 3);
  }

  // Distance labels
  ctx.textAlign = 'center';
  const numDistLabels = 4;
  for (let i = 0; i <= numDistLabels; i++) {
    const dist = (maxDist * i) / numDistLabels;
    const x = padding.left + (plotW * i) / numDistLabels;
    ctx.fillText(`${(dist / 1609.34).toFixed(1)}mi`, x, height - 6);
  }
}

function metersToFeet(m) {
  return m * 3.28084;
}

// Format distance for display
export function formatDistance(meters) {
  const miles = meters / 1609.34;
  return miles < 0.1 ? `${Math.round(meters)} m` : `${miles.toFixed(1)} mi`;
}

// Format elevation for display
export function formatElevation(meters) {
  return `${Math.round(metersToFeet(meters))}'`;
}

// Import GPX from file, parse, render, and save to IndexedDB
export async function importGPX(file) {
  const text = await file.text();
  const parsed = parseGPX(text);
  const stats = calcRouteStats(parsed.trackpoints);

  const route = {
    id: crypto.randomUUID(),
    name: parsed.name,
    gpxData: text,
    trackpoints: parsed.trackpoints,
    waypoints: parsed.waypoints,
    stats,
    date: new Date().toISOString(),
    status: 'planned',
    classRating: null,
    conditions: '',
    beta: '',
    waterSources: '',
    tags: [],
    createdAt: new Date().toISOString(),
  };

  await saveRoute(route);
  renderRoute(parsed.trackpoints, parsed.waypoints);

  activeRoute = route;
  return route;
}

// Load a previously saved route onto the map
export function loadRoute(route) {
  const parsed = parseGPX(route.gpxData);
  renderRoute(parsed.trackpoints, parsed.waypoints);
  activeRoute = route;
  return route;
}

export function getActiveRoute() {
  return activeRoute;
}

export function setActiveRoute(route) {
  activeRoute = route;
}
