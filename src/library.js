// GPX Library — route list, metadata editing, search/filter, JSON backup

import { getAllRoutes, saveRoute, deleteRoute, getRoute } from './db.js';
import { loadRoute, setActiveRoute, formatDistance, formatElevation, renderRoute, clearRoute, parseGPX, calcRouteStats } from './gpx.js';
import { showRouteInfo } from './ui.js';

let libraryPanel = null;
let allRoutes = [];

export function initLibrary() {
  createLibraryButton();
}

function createLibraryButton() {
  const control = document.createElement('div');
  control.className = 'map-control top-left-library';
  control.innerHTML = `
    <button id="library-btn" class="control-btn" title="Route library">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        <line x1="8" y1="7" x2="16" y2="7"/>
        <line x1="8" y1="11" x2="13" y2="11"/>
      </svg>
    </button>
  `;
  document.body.appendChild(control);

  document.getElementById('library-btn').addEventListener('click', () => {
    showLibrary();
  });
}

async function showLibrary() {
  allRoutes = await getAllRoutes();

  if (libraryPanel) {
    libraryPanel.remove();
  }

  libraryPanel = document.createElement('div');
  libraryPanel.className = 'library-overlay';
  libraryPanel.innerHTML = `
    <div class="library-container">
      <div class="library-header">
        <h2 class="library-title">Route Library</h2>
        <button id="close-library" class="panel-close-btn">&times;</button>
      </div>

      <div class="library-toolbar">
        <input type="text" id="library-search" class="cache-input" placeholder="Search routes..." />
        <div class="library-filters">
          <select id="filter-status" class="cache-select">
            <option value="">All Status</option>
            <option value="planned">Planned</option>
            <option value="completed">Completed</option>
          </select>
          <select id="filter-class" class="cache-select">
            <option value="">All Class</option>
            <option value="1">Class 1</option>
            <option value="2">Class 2</option>
            <option value="3">Class 3</option>
            <option value="4">Class 4</option>
            <option value="5">Class 5</option>
          </select>
        </div>
        <div class="library-actions">
          <button id="export-library" class="lib-action-btn">Export JSON</button>
          <button id="import-library" class="lib-action-btn">Import JSON</button>
          <input type="file" id="import-json-input" accept=".json" style="display:none">
        </div>
      </div>

      <div id="library-list" class="library-list"></div>
    </div>
  `;
  document.body.appendChild(libraryPanel);

  document.getElementById('close-library').addEventListener('click', () => {
    libraryPanel.remove();
    libraryPanel = null;
  });

  document.getElementById('library-search').addEventListener('input', () => renderList());
  document.getElementById('filter-status').addEventListener('change', () => renderList());
  document.getElementById('filter-class').addEventListener('change', () => renderList());

  document.getElementById('export-library').addEventListener('click', exportLibrary);
  document.getElementById('import-library').addEventListener('click', () => {
    document.getElementById('import-json-input').click();
  });
  document.getElementById('import-json-input').addEventListener('change', importLibrary);

  renderList();
}

function getFilteredRoutes() {
  const search = (document.getElementById('library-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('filter-status')?.value || '';
  const classFilter = document.getElementById('filter-class')?.value || '';

  return allRoutes.filter((r) => {
    if (search) {
      const searchable = `${r.name} ${r.tags?.join(' ') || ''} ${r.beta || ''} ${r.conditions || ''}`.toLowerCase();
      if (!searchable.includes(search)) return false;
    }
    if (statusFilter && r.status !== statusFilter) return false;
    if (classFilter && r.classRating !== parseInt(classFilter)) return false;
    return true;
  });
}

function renderList() {
  const routes = getFilteredRoutes();
  const container = document.getElementById('library-list');

  if (routes.length === 0) {
    container.innerHTML = '<div class="empty-state">No routes found</div>';
    return;
  }

  container.innerHTML = routes
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((r) => {
      const dist = r.stats ? formatDistance(r.stats.totalDistance) : '--';
      const gain = r.stats ? `+${formatElevation(r.stats.totalGain)}` : '--';
      const statusBadge = r.status === 'completed'
        ? '<span class="status-badge completed">Done</span>'
        : '<span class="status-badge planned">Planned</span>';
      const classBadge = r.classRating ? `<span class="class-badge">C${r.classRating}</span>` : '';
      const tags = (r.tags || []).map((t) => `<span class="tag">${escapeHTML(t)}</span>`).join('');

      return `
        <div class="route-card" data-id="${r.id}">
          <div class="route-card-header">
            <span class="route-card-name">${escapeHTML(r.name)}</span>
            <div class="route-card-badges">${statusBadge}${classBadge}</div>
          </div>
          <div class="route-card-stats">
            <span>${dist}</span>
            <span>${gain}</span>
            <span>${r.date ? new Date(r.date).toLocaleDateString() : ''}</span>
          </div>
          ${tags ? `<div class="route-card-tags">${tags}</div>` : ''}
          <div class="route-card-actions">
            <button class="route-card-btn load-route" data-id="${r.id}">Load</button>
            <button class="route-card-btn edit-route" data-id="${r.id}">Edit</button>
            <button class="route-card-btn delete-route" data-id="${r.id}">Delete</button>
          </div>
        </div>
      `;
    })
    .join('');

  // Bind actions
  container.querySelectorAll('.load-route').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const route = await getRoute(btn.dataset.id);
      if (route) {
        loadRoute(route);
        showRouteInfo(route);
        libraryPanel.remove();
        libraryPanel = null;
      }
    });
  });

  container.querySelectorAll('.edit-route').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const route = await getRoute(btn.dataset.id);
      if (route) showEditForm(route);
    });
  });

  container.querySelectorAll('.delete-route').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteRoute(btn.dataset.id);
      allRoutes = await getAllRoutes();
      renderList();
    });
  });
}

function showEditForm(route) {
  const container = document.getElementById('library-list');
  container.innerHTML = `
    <div class="edit-form">
      <h3 class="edit-form-title">Edit Route</h3>
      <div class="cache-field">
        <label>Name</label>
        <input type="text" id="edit-name" class="cache-input" value="${escapeAttr(route.name)}" />
      </div>
      <div class="cache-field">
        <label>Date</label>
        <input type="date" id="edit-date" class="cache-input" value="${route.date ? route.date.slice(0, 10) : ''}" />
      </div>
      <div class="cache-field">
        <label>Status</label>
        <select id="edit-status" class="cache-select" style="width:100%">
          <option value="planned" ${route.status === 'planned' ? 'selected' : ''}>Planned</option>
          <option value="completed" ${route.status === 'completed' ? 'selected' : ''}>Completed</option>
        </select>
      </div>
      <div class="cache-field">
        <label>Class Rating</label>
        <select id="edit-class" class="cache-select" style="width:100%">
          <option value="" ${!route.classRating ? 'selected' : ''}>None</option>
          <option value="1" ${route.classRating === 1 ? 'selected' : ''}>Class 1</option>
          <option value="2" ${route.classRating === 2 ? 'selected' : ''}>Class 2</option>
          <option value="3" ${route.classRating === 3 ? 'selected' : ''}>Class 3</option>
          <option value="4" ${route.classRating === 4 ? 'selected' : ''}>Class 4</option>
          <option value="5" ${route.classRating === 5 ? 'selected' : ''}>Class 5</option>
        </select>
      </div>
      <div class="cache-field">
        <label>Conditions Notes</label>
        <textarea id="edit-conditions" class="cache-textarea">${escapeHTML(route.conditions || '')}</textarea>
      </div>
      <div class="cache-field">
        <label>Beta Notes</label>
        <textarea id="edit-beta" class="cache-textarea">${escapeHTML(route.beta || '')}</textarea>
      </div>
      <div class="cache-field">
        <label>Water Sources</label>
        <textarea id="edit-water" class="cache-textarea">${escapeHTML(route.waterSources || '')}</textarea>
      </div>
      <div class="cache-field">
        <label>Tags (comma-separated)</label>
        <input type="text" id="edit-tags" class="cache-input" value="${(route.tags || []).join(', ')}" />
      </div>
      <div class="edit-form-actions">
        <button id="save-edit" class="cache-action-btn accent">Save</button>
        <button id="cancel-edit" class="cache-action-btn">Cancel</button>
      </div>
    </div>
  `;

  document.getElementById('save-edit').addEventListener('click', async () => {
    route.name = document.getElementById('edit-name').value;
    route.date = document.getElementById('edit-date').value || route.date;
    route.status = document.getElementById('edit-status').value;
    const classVal = document.getElementById('edit-class').value;
    route.classRating = classVal ? parseInt(classVal) : null;
    route.conditions = document.getElementById('edit-conditions').value;
    route.beta = document.getElementById('edit-beta').value;
    route.waterSources = document.getElementById('edit-water').value;
    route.tags = document.getElementById('edit-tags').value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    await saveRoute(route);
    allRoutes = await getAllRoutes();
    renderList();
  });

  document.getElementById('cancel-edit').addEventListener('click', () => {
    renderList();
  });
}

async function exportLibrary() {
  const routes = await getAllRoutes();
  const blob = new Blob([JSON.stringify(routes, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trailmap-library-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importLibrary(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const routes = JSON.parse(text);

    if (!Array.isArray(routes)) throw new Error('Invalid format');

    for (const route of routes) {
      if (!route.id || !route.gpxData) continue;

      // Re-parse to ensure consistency
      const parsed = parseGPX(route.gpxData);
      route.trackpoints = parsed.trackpoints;
      route.waypoints = parsed.waypoints;
      route.stats = calcRouteStats(parsed.trackpoints);

      await saveRoute(route);
    }

    allRoutes = await getAllRoutes();
    renderList();
  } catch (err) {
    console.error('Import failed:', err);
  }

  e.target.value = '';
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
