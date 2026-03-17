// UI: panels, bottom sheets, drag-and-drop, route info display

import { importGPX, getActiveRoute, calcRouteStats, drawElevationProfile, formatDistance, formatElevation, parseGPX } from './gpx.js';

let routePanel = null;

export function initUI() {
  createRouteInfoPanel();
  initDragDrop();
  initFileInput();
}

function createRouteInfoPanel() {
  routePanel = document.createElement('div');
  routePanel.className = 'bottom-sheet';
  routePanel.id = 'route-panel';
  routePanel.innerHTML = `
    <div class="bottom-sheet-handle" id="route-panel-handle"></div>
    <div class="route-info-content">
      <div class="route-header">
        <h3 id="route-name" class="route-title"></h3>
        <button id="close-route-panel" class="panel-close-btn">&times;</button>
      </div>
      <div class="route-stats" id="route-stats"></div>
      <div class="elevation-profile-container">
        <canvas id="elevation-canvas"></canvas>
      </div>
    </div>
  `;
  document.body.appendChild(routePanel);

  // Close button
  document.getElementById('close-route-panel').addEventListener('click', () => {
    routePanel.classList.remove('open');
  });

  // Handle drag to dismiss
  let startY = 0;
  let currentY = 0;
  const handle = document.getElementById('route-panel-handle');

  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    routePanel.style.transition = 'none';
  });

  handle.addEventListener('touchmove', (e) => {
    currentY = e.touches[0].clientY;
    const diff = currentY - startY;
    if (diff > 0) {
      routePanel.style.transform = `translateY(${diff}px)`;
    }
  });

  handle.addEventListener('touchend', () => {
    routePanel.style.transition = 'transform 0.3s ease-out';
    const diff = currentY - startY;
    if (diff > 80) {
      routePanel.classList.remove('open');
      routePanel.style.transform = '';
    } else {
      routePanel.style.transform = '';
    }
  });
}

export function showRouteInfo(route) {
  const stats = route.stats;

  document.getElementById('route-name').textContent = route.name;

  document.getElementById('route-stats').innerHTML = `
    <div class="stat-row">
      <div class="stat">
        <span class="stat-label">Distance</span>
        <span class="stat-value">${formatDistance(stats.totalDistance)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Gain</span>
        <span class="stat-value">+${formatElevation(stats.totalGain)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Loss</span>
        <span class="stat-value">-${formatElevation(stats.totalLoss)}</span>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat">
        <span class="stat-label">Min Elev</span>
        <span class="stat-value">${formatElevation(stats.minElevation)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Max Elev</span>
        <span class="stat-value">${formatElevation(stats.maxElevation)}</span>
      </div>
    </div>
  `;

  routePanel.classList.add('open');

  // Draw elevation profile after panel is visible
  requestAnimationFrame(() => {
    const canvas = document.getElementById('elevation-canvas');
    drawElevationProfile(canvas, route.trackpoints, stats.distances);
  });
}

function initDragDrop() {
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.className = 'drop-overlay hidden';
  overlay.innerHTML = '<span class="drop-text">Drop GPX file</span>';
  document.body.appendChild(overlay);

  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    overlay.classList.remove('hidden');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.add('hidden');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.add('hidden');

    const files = [...e.dataTransfer.files].filter(
      (f) => f.name.endsWith('.gpx') || f.type === 'application/gpx+xml'
    );

    if (files.length > 0) {
      const route = await importGPX(files[0]);
      showRouteInfo(route);
    }
  });
}

function initFileInput() {
  // Add import button to the UI
  const importBtn = document.createElement('div');
  importBtn.className = 'map-control top-left';
  importBtn.innerHTML = `
    <button id="import-btn" class="control-btn" title="Import GPX">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
    </button>
    <input type="file" id="gpx-file-input" accept=".gpx" style="display:none">
  `;
  document.body.appendChild(importBtn);

  document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('gpx-file-input').click();
  });

  document.getElementById('gpx-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      const route = await importGPX(file);
      showRouteInfo(route);
    }
    e.target.value = '';
  });
}
