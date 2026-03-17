// Live GPS tracking, route progress calculation, and breadcrumb trail

import { getMap, showGpsPosition } from './map.js';
import { getActiveRoute, calcRouteStats } from './gpx.js';

let watchId = null;
let tracking = false;
let breadcrumbs = [];
let lastPosition = null;
let totalMovingDistance = 0;
let movingTimes = [];
let trackingStartTime = null;

// Start live GPS tracking
export function startTracking(onUpdate) {
  if (tracking) return;
  if (!navigator.geolocation) {
    console.warn('Geolocation not supported');
    return;
  }

  tracking = true;
  breadcrumbs = [];
  totalMovingDistance = 0;
  movingTimes = [];
  trackingStartTime = Date.now();
  lastPosition = null;

  // watchPosition keeps updating as the user moves
  // Note: On mobile PWAs, background GPS tracking is limited.
  // iOS Safari will pause watchPosition when the app is backgrounded.
  // Android Chrome is somewhat better but still throttles.
  // For best results, keep the screen on during navigation.
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy, altitude, speed, heading } = pos.coords;
      const timestamp = pos.timestamp;

      const position = { lat: latitude, lng: longitude, accuracy, altitude, speed, heading, timestamp };

      // Update GPS dot on map
      showGpsPosition(longitude, latitude, accuracy);

      // Track breadcrumbs
      breadcrumbs.push([longitude, latitude]);
      updateBreadcrumbTrail();

      // Calculate speed from actual movement if device doesn't provide it
      if (lastPosition && (!speed || speed < 0)) {
        const dist = haversine(lastPosition.lat, lastPosition.lng, latitude, longitude);
        const dt = (timestamp - lastPosition.timestamp) / 1000;
        if (dt > 0) {
          position.speed = dist / dt;
        }
      }

      // Track moving distance and times for average speed
      if (lastPosition) {
        const dist = haversine(lastPosition.lat, lastPosition.lng, latitude, longitude);
        const dt = (timestamp - lastPosition.timestamp) / 1000;
        // Only count as "moving" if speed > 0.3 m/s (~0.7 mph) to filter GPS jitter
        if (dist / dt > 0.3) {
          totalMovingDistance += dist;
          movingTimes.push(dt);
        }
      }

      lastPosition = position;

      // Calculate route progress if a route is loaded
      const progress = calcProgress(position);

      if (onUpdate) onUpdate(position, progress);
    },
    (err) => {
      console.warn('GPS error:', err.message);
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 3000,
    }
  );
}

export function stopTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  tracking = false;
}

export function isTracking() {
  return tracking;
}

// Calculate progress along the active route
function calcProgress(position) {
  const route = getActiveRoute();
  if (!route || !route.trackpoints || route.trackpoints.length < 2) {
    return null;
  }

  const pts = route.trackpoints;
  const stats = route.stats;

  // Find nearest point on route
  let minDist = Infinity;
  let nearestIdx = 0;

  for (let i = 0; i < pts.length; i++) {
    const d = haversine(position.lat, position.lng, pts[i].lat, pts[i].lon);
    if (d < minDist) {
      minDist = d;
      nearestIdx = i;
    }
  }

  // Snap-to-route: also check segments for closest point on line
  let snappedIdx = nearestIdx;
  let snappedDist = minDist;
  let snappedPoint = { lat: pts[nearestIdx].lat, lng: pts[nearestIdx].lon };

  for (let i = 0; i < pts.length - 1; i++) {
    const closest = closestPointOnSegment(
      position.lat, position.lng,
      pts[i].lat, pts[i].lon,
      pts[i + 1].lat, pts[i + 1].lon
    );
    if (closest.dist < snappedDist) {
      snappedDist = closest.dist;
      snappedIdx = i;
      snappedPoint = closest;
    }
  }

  // Distance completed along route up to nearest index
  const distCompleted = stats.distances[snappedIdx] || 0;
  const distRemaining = stats.totalDistance - distCompleted;

  // Elevation progress
  let eleGainSoFar = 0;
  for (let i = 1; i <= snappedIdx && i < pts.length; i++) {
    if (pts[i].ele !== null && pts[i - 1].ele !== null) {
      const diff = pts[i].ele - pts[i - 1].ele;
      if (diff > 0) eleGainSoFar += diff;
    }
  }
  const eleRemaining = stats.totalGain - eleGainSoFar;

  // Current elevation (from GPS altitude or route point)
  const currentEle = position.altitude || (pts[snappedIdx]?.ele ?? null);

  // Moving average speed
  const totalMovingTime = movingTimes.reduce((a, b) => a + b, 0);
  const avgSpeed = totalMovingTime > 0 ? totalMovingDistance / totalMovingTime : 0;

  // ETA based on remaining distance and moving average
  const etaSeconds = avgSpeed > 0 ? distRemaining / avgSpeed : null;

  // Percent complete
  const pctComplete = stats.totalDistance > 0 ? (distCompleted / stats.totalDistance) * 100 : 0;

  return {
    distCompleted,
    distRemaining,
    eleGainSoFar,
    eleRemaining,
    currentEle,
    currentSpeed: position.speed || 0,
    avgSpeed,
    etaSeconds,
    pctComplete,
    offRoute: snappedDist > 50, // > 50m from route
    offRouteDistance: snappedDist,
    snappedPoint,
    nearestIdx: snappedIdx,
  };
}

// Find the closest point on a line segment to a given point
function closestPointOnSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
  const dx = bLng - aLng;
  const dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return { lat: aLat, lng: aLng, dist: haversine(pLat, pLng, aLat, aLng) };
  }

  let t = ((pLng - aLng) * dx + (pLat - aLat) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const closestLat = aLat + t * dy;
  const closestLng = aLng + t * dx;

  return {
    lat: closestLat,
    lng: closestLng,
    dist: haversine(pLat, pLng, closestLat, closestLng),
  };
}

// Haversine distance in meters
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

// Render breadcrumb trail on map
function updateBreadcrumbTrail() {
  const map = getMap();
  if (breadcrumbs.length < 2) return;

  const data = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: breadcrumbs },
  };

  if (map.getSource('breadcrumbs')) {
    map.getSource('breadcrumbs').setData(data);
  } else {
    map.addSource('breadcrumbs', { type: 'geojson', data });
    map.addLayer({
      id: 'breadcrumb-line',
      type: 'line',
      source: 'breadcrumbs',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#3b82f6',
        'line-width': 3,
        'line-dasharray': [2, 4],
        'line-opacity': 0.7,
      },
    });
  }
}

export function getBreadcrumbs() {
  return breadcrumbs;
}

export function getTrackingStats() {
  return {
    totalMovingDistance,
    totalMovingTime: movingTimes.reduce((a, b) => a + b, 0),
    breadcrumbs: breadcrumbs.length,
  };
}
