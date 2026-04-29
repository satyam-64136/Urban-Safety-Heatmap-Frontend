/**
 * script.js — Dehradun Urban Safety Heatmap v2
 *
 * Improvements:
 *  - Debounced slider (300ms) — prevents 23 API calls per drag
 *  - Offline fallback — mirrors data.py logic in JS so app works without Flask
 *  - Zone list panel — sortable sidebar list of all zones by risk level
 *  - Auto-refresh every 5 minutes when on "current" time
 *  - Status badge shows SIMULATED vs LIVE accurately
 *  - risk_index displayed in popups
 */

// ── Config ───────────────────────────────────────────────────────────────────
const API_BASE        = 'https://urban-safety-heatmap-backend.onrender.com';
const MAP_CENTER      = [30.3165, 78.0322];
const MAP_ZOOM        = 12;
const AUTO_REFRESH_MS = 5 * 60 * 1000;   // 5 minutes
const SLIDER_DEBOUNCE = 300;              // ms

// ── State ────────────────────────────────────────────────────────────────────
let currentView   = 'crime';
let currentHour   = new Date().getHours();
let isSimulating  = false;     // true when slider moved away from real time
let zoneData      = [];
let heatLayer     = null;
let markerGroup   = null;
let map           = null;
let sliderTimer   = null;
let autoRefreshId = null;
let backendOnline = true;

// ── DOM Refs ─────────────────────────────────────────────────────────────────
const loadingOverlay = document.getElementById('loading-overlay');
const liveClock      = document.getElementById('live-clock');
const statusBadge    = document.getElementById('status-badge');
const timeSlider     = document.getElementById('time-slider');
const timeLabel      = document.getElementById('time-label');
const timePeriod     = document.getElementById('time-period');
const toast          = document.getElementById('toast');
const statSafe       = document.getElementById('stat-safe');
const statMedium     = document.getElementById('stat-medium');
const statRisky      = document.getElementById('stat-risky');
const zoneListBody   = document.getElementById('zone-list-body');

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatHour(h) {
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return { label: `${String(h12).padStart(2, '0')}:00`, period: ampm };
}

let toastTimer = null;
function showToast(msg, duration = 2800) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

function updateSliderFill(slider) {
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty('--fill-pct', pct + '%');
}

// ── Status Badge ──────────────────────────────────────────────────────────────

function updateStatusBadge() {
  if (!backendOnline) {
    statusBadge.textContent  = 'OFFLINE';
    statusBadge.dataset.mode = 'offline';
  } else if (isSimulating) {
    statusBadge.textContent  = 'SIMULATED';
    statusBadge.dataset.mode = 'simulated';
  } else {
    statusBadge.textContent  = 'LIVE';
    statusBadge.dataset.mode = 'live';
  }
}

// ── Live Clock ────────────────────────────────────────────────────────────────

function updateLiveClock() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  const ss  = String(now.getSeconds()).padStart(2, '0');
  liveClock.textContent = `${hh}:${mm}:${ss}`;
}
updateLiveClock();
setInterval(updateLiveClock, 1000);

// ── Offline Fallback ──────────────────────────────────────────────────────────
// Mirrors data.py + model.py logic so the app works without Flask.

const OFFLINE_ZONES = [
  { id:1,  name:"Rajpur Road",              lat:30.3433, lng:78.0631, base_crime:35, busy:true,  desc:"Major commercial and residential corridor" },
  { id:2,  name:"ISBT Dehradun",            lat:30.2963, lng:78.0285, base_crime:62, busy:true,  desc:"Inter-State Bus Terminal — high footfall, elevated night risk" },
  { id:3,  name:"Ballupur",                 lat:30.3074, lng:78.0723, base_crime:28, busy:false, desc:"Residential zone near ONGC campus" },
  { id:4,  name:"Prem Nagar",               lat:30.2872, lng:77.9960, base_crime:55, busy:false, desc:"Suburban locality on Haridwar road" },
  { id:5,  name:"Clement Town",             lat:30.2623, lng:78.0110, base_crime:48, busy:false, desc:"Mixed-use zone with military presence" },
  { id:6,  name:"Sahastradhara Road",       lat:30.3612, lng:78.1022, base_crime:22, busy:false, desc:"Scenic road towards sulphur springs — generally calm" },
  { id:7,  name:"Clock Tower (Ghanta Ghar)",lat:30.3204, lng:78.0430, base_crime:45, busy:true,  desc:"Central landmark and commercial hub — busy evenings" },
  { id:8,  name:"Rispana Bridge",           lat:30.3005, lng:78.0550, base_crime:58, busy:false, desc:"Urban junction near Rispana River — elevated late-night risk" },
  { id:9,  name:"Dalanwala",                lat:30.3280, lng:78.0592, base_crime:30, busy:false, desc:"Old Dehradun residential locality" },
  { id:10, name:"Karanpur",                 lat:30.3155, lng:78.0395, base_crime:50, busy:true,  desc:"Busy market area in central Dehradun" },
  { id:11, name:"Paltan Bazaar",            lat:30.3168, lng:78.0342, base_crime:52, busy:true,  desc:"Dense retail market near railway station" },
  { id:12, name:"Dehradun Railway Station", lat:30.3138, lng:78.0340, base_crime:60, busy:true,  desc:"Major rail hub — peak crowd at train arrivals" },
  { id:13, name:"Mussoorie Diversion",      lat:30.3680, lng:78.0725, base_crime:32, busy:false, desc:"Junction towards Mussoorie hills — tourist transit zone" },
  { id:14, name:"Niranjanpur",              lat:30.3046, lng:78.0848, base_crime:42, busy:false, desc:"Residential and commercial mix on Ring Road" },
  { id:15, name:"Chakrata Road",            lat:30.3369, lng:77.9989, base_crime:38, busy:false, desc:"Western corridor towards Chakrata hills" },
  { id:16, name:"Doiwala",                  lat:30.1834, lng:78.1180, base_crime:44, busy:false, desc:"Small town on Rishikesh road, semi-rural" },
  { id:17, name:"Raipur Road",              lat:30.3542, lng:78.0912, base_crime:26, busy:false, desc:"Quieter route through forest-adjacent neighbourhoods" },
  { id:18, name:"Nehru Colony",             lat:30.3095, lng:78.0635, base_crime:33, busy:false, desc:"Dense residential colony, moderate activity" },
  { id:19, name:"Haridwar Bypass",          lat:30.2715, lng:78.0048, base_crime:65, busy:false, desc:"Highway stretch — isolated at night" },
  { id:20, name:"Sewla Kalan",              lat:30.2550, lng:78.0370, base_crime:70, busy:false, desc:"Peripheral zone, lower surveillance density" },
  { id:21, name:"EC Road",                  lat:30.3342, lng:78.0518, base_crime:29, busy:false, desc:"University-area road, safe during day" },
  { id:22, name:"Bindal Bridge",            lat:30.2924, lng:78.0721, base_crime:55, busy:false, desc:"River crossing — poor lighting, elevated night risk" },
];

// Night multiplier table mirroring data.py
const TIME_RISK = {
  "ISBT Dehradun":             [[range22_24, 1.45], [range0_5,  1.50]],
  "Rispana Bridge":            [[range22_24, 1.40], [range0_6,  1.60]],
  "Haridwar Bypass":           [[range21_24, 1.50], [range0_5,  1.55]],
  "Sewla Kalan":               [[range20_24, 1.55], [range0_5,  1.60]],
  "Bindal Bridge":             [[range21_24, 1.45], [range0_5,  1.50]],
  "Dehradun Railway Station":  [[range23_24, 1.35], [range0_5,  1.30]],
  "Clock Tower (Ghanta Ghar)": [[range22_24, 1.30]],
  "Prem Nagar":                [[range22_24, 1.25], [range0_5,  1.30]],
  "Clement Town":              [[range0_5,   1.25]],
};

function range20_24(h){ return h>=20&&h<24; }
function range21_24(h){ return h>=21&&h<24; }
function range22_24(h){ return h>=22&&h<24; }
function range23_24(h){ return h>=23&&h<24; }
function range0_5(h){   return h>=0&&h<5;   }
function range0_6(h){   return h>=0&&h<6;   }

// Re-key TIME_RISK using actual functions (defined above)
const TIME_RISK_FN = {
  "ISBT Dehradun":             [[range22_24, 1.45], [range0_5,  1.50]],
  "Rispana Bridge":            [[range22_24, 1.40], [range0_6,  1.60]],
  "Haridwar Bypass":           [[range21_24, 1.50], [range0_5,  1.55]],
  "Sewla Kalan":               [[range20_24, 1.55], [range0_5,  1.60]],
  "Bindal Bridge":             [[range21_24, 1.45], [range0_5,  1.50]],
  "Dehradun Railway Station":  [[range23_24, 1.35], [range0_5,  1.30]],
  "Clock Tower (Ghanta Ghar)": [[range22_24, 1.30]],
  "Prem Nagar":                [[range22_24, 1.25], [range0_5,  1.30]],
  "Clement Town":              [[range0_5,   1.25]],
};

function offlineCrimeScore(zone, hour) {
  const base    = zone.base_crime;
  const entries = TIME_RISK_FN[zone.name] || [];
  for (const [fn, mult] of entries) {
    if (fn(hour)) return Math.min(100, Math.floor(base * mult));
  }
  return base;
}

function offlineCrowdScore(zone, hour) {
  const [base, amp] = zone.busy ? [65, 28] : [42, 22];
  const angle = Math.PI * (hour - 3) / 20;
  return Math.max(5, Math.min(95, Math.round(base + amp * Math.sin(angle))));
}

function offlineSafetyScore(crime, crowd) {
  const crowdRisk = Math.max(0, crowd - 60) * 0.30;
  return Math.max(0, Math.min(100, +(100 - crime * 0.65 - crowdRisk).toFixed(2)));
}

function offlineRiskIndex(crime, crowd) {
  const isolation = Math.max(0, (35 - crowd) * 0.30);
  return +(crime * 0.70 + isolation).toFixed(2);
}

function offlineAiClass(risk) {
  if (risk < 38) return 'Safe';
  if (risk < 60) return 'Medium';
  return 'Risky';
}

function computeLocalData(hour) {
  return OFFLINE_ZONES.map(z => {
    const crime  = offlineCrimeScore(z, hour);
    const crowd  = offlineCrowdScore(z, hour);
    const safety = offlineSafetyScore(crime, crowd);
    const risk   = offlineRiskIndex(crime, crowd);
    return {
      id: z.id, name: z.name, lat: z.lat, lng: z.lng,
      crime_score: crime, crowd_score: crowd,
      safety_score: safety, risk_index: risk,
      ai_class: offlineAiClass(risk),
      description: z.desc,
    };
  });
}

// ── API Fetch with Offline Fallback ───────────────────────────────────────────

async function fetchZoneData(hour) {
  try {
    const res = await fetch(`${API_BASE}/predict?hour=${hour}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!backendOnline) {
      backendOnline = true;
      showToast('✓ Backend reconnected');
    }
    backendOnline = true;
    updateStatusBadge();
    return json.data;
  } catch {
    if (backendOnline) {
      backendOnline = false;
      showToast('⚠ Flask offline — using local data', 4000);
      updateStatusBadge();
    }
    return computeLocalData(hour);
  }
}

// ── Map Init ──────────────────────────────────────────────────────────────────

function initMap() {
  map = L.map('map', {
    center:           MAP_CENTER,
    zoom:             MAP_ZOOM,
    zoomControl:      false,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://carto.com">CartoDB</a>',
    subdomains:  'abcd',
    maxZoom:     19,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  markerGroup = L.layerGroup().addTo(map);
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

function buildHeatPoints(data, view) {
  return data.map(zone => {
    let raw;
    if (view === 'crime')       raw = zone.crime_score / 100;
    else if (view === 'crowd')  raw = zone.crowd_score / 100;
    else {
      const aiMap = { Safe: 0.15, Medium: 0.55, Risky: 1.0 };
      raw = aiMap[zone.ai_class] ?? 0.5;
    }
    return [zone.lat, zone.lng, raw];
  });
}

const HEAT_GRADIENTS = {
  crime: { 0.0:'#001f00', 0.3:'#22c55e', 0.6:'#f59e0b', 1.0:'#ef4444' },
  crowd: { 0.0:'#000a1f', 0.3:'#1e40af', 0.6:'#3b82f6', 1.0:'#93c5fd' },
  ai:    { 0.0:'#001500', 0.2:'#22c55e', 0.5:'#f59e0b', 1.0:'#ef4444' },
};

function renderHeatmap(data, view) {
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  heatLayer = L.heatLayer(buildHeatPoints(data, view), {
    radius: 50, blur: 35, maxZoom: 16, max: 1.0,
    minOpacity: 0.35, gradient: HEAT_GRADIENTS[view],
  }).addTo(map);
}

// ── Markers & Popups ──────────────────────────────────────────────────────────

function aiClassColor(cls) {
  return { Safe:'#22c55e', Medium:'#f59e0b', Risky:'#ef4444' }[cls] || '#fff';
}

function buildPopupHTML(zone) {
  const safetyDisplay = isNaN(zone.safety_score) ? '—' : zone.safety_score.toFixed(1);
  const riskDisplay   = zone.risk_index != null ? zone.risk_index.toFixed(1) : '—';
  return `
    <div class="popup-card">
      <div class="popup-zone-name">${zone.name}</div>
      <div class="popup-description">${zone.description || ''}</div>
      <div class="popup-scores">
        <div class="popup-score-item">
          <div class="popup-score-label">Crime Score</div>
          <div class="popup-score-value">${zone.crime_score}</div>
        </div>
        <div class="popup-score-item">
          <div class="popup-score-label">Crowd Score</div>
          <div class="popup-score-value">${zone.crowd_score}</div>
        </div>
        <div class="popup-score-item">
          <div class="popup-score-label">Safety Index</div>
          <div class="popup-score-value">${safetyDisplay}</div>
        </div>
        <div class="popup-score-item">
          <div class="popup-score-label">Risk Index</div>
          <div class="popup-score-value">${riskDisplay}</div>
        </div>
      </div>
      <div class="popup-ai-badge ${zone.ai_class}">
        ● &nbsp;${zone.ai_class} Zone &nbsp;·&nbsp; ${String(currentHour).padStart(2,'0')}:00
      </div>
    </div>`;
}

function renderMarkers(data) {
  markerGroup.clearLayers();
  data.forEach(zone => {
    const color = aiClassColor(zone.ai_class);
    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:12px;height:12px;border-radius:50%;
        background:${color};
        box-shadow:0 0 8px ${color},0 0 20px ${color}60;
        border:2px solid rgba(255,255,255,0.25);
        cursor:pointer;
      "></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6],
    });
    const marker = L.marker([zone.lat, zone.lng], { icon });
    marker.bindPopup(buildPopupHTML(zone), { maxWidth: 280, className: 'custom-popup' });
    marker.bindTooltip(zone.name, { permanent:false, direction:'top', offset:[0,-8], className:'custom-tooltip' });
    markerGroup.addLayer(marker);
  });
}

// ── Zone List Panel ───────────────────────────────────────────────────────────

let zoneSortOrder = 'risk';  // 'risk' | 'name' | 'safety'

function renderZoneList(data) {
  if (!zoneListBody) return;

  const sorted = [...data].sort((a, b) => {
    if (zoneSortOrder === 'risk') {
      // Sort by ai_class severity then risk_index
      const order = { Risky: 0, Medium: 1, Safe: 2 };
      const diff = order[a.ai_class] - order[b.ai_class];
      return diff !== 0 ? diff : (b.risk_index || 0) - (a.risk_index || 0);
    }
    if (zoneSortOrder === 'name')   return a.name.localeCompare(b.name);
    if (zoneSortOrder === 'safety') return a.safety_score - b.safety_score;
    return 0;
  });

  zoneListBody.innerHTML = sorted.map(zone => {
    const color = aiClassColor(zone.ai_class);
    const barW  = Math.round((zone.crime_score / 100) * 100);
    return `
      <div class="zone-row" data-id="${zone.id}" title="${zone.description}">
        <div class="zone-row-left">
          <div class="zone-dot" style="background:${color};box-shadow:0 0 6px ${color}80"></div>
          <div class="zone-row-info">
            <div class="zone-row-name">${zone.name}</div>
            <div class="zone-row-bar-wrap">
              <div class="zone-row-bar" style="width:${barW}%;background:${color}40;border-right:2px solid ${color}"></div>
            </div>
          </div>
        </div>
        <div class="zone-row-right">
          <span class="zone-badge ${zone.ai_class}">${zone.ai_class}</span>
          <span class="zone-crime">${zone.crime_score}</span>
        </div>
      </div>`;
  }).join('');

  // Click zone row → open its marker popup & pan map
  zoneListBody.querySelectorAll('.zone-row').forEach(row => {
    row.addEventListener('click', () => {
      const id   = parseInt(row.dataset.id);
      const zone = data.find(z => z.id === id);
      if (!zone) return;
      map.setView([zone.lat, zone.lng], 15, { animate: true });
      markerGroup.eachLayer(m => {
        const ll = m.getLatLng();
        if (Math.abs(ll.lat - zone.lat) < 0.0001 && Math.abs(ll.lng - zone.lng) < 0.0001) {
          m.openPopup();
        }
      });
    });
  });
}

// Sort tab clicks
document.querySelectorAll('.sort-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sort-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    zoneSortOrder = tab.dataset.sort;
    renderZoneList(zoneData);
  });
});

// ── Stats Panel ───────────────────────────────────────────────────────────────

function updateStats(data) {
  const counts = { Safe:0, Medium:0, Risky:0 };
  data.forEach(z => counts[z.ai_class] = (counts[z.ai_class] || 0) + 1);
  statSafe.textContent   = counts.Safe   || 0;
  statMedium.textContent = counts.Medium || 0;
  statRisky.textContent  = counts.Risky  || 0;
}

// ── Full Refresh ──────────────────────────────────────────────────────────────

async function refresh(hour, view, showLoader = false) {
  if (showLoader) loadingOverlay.classList.remove('hidden');
  try {
    zoneData = await fetchZoneData(hour);
    renderHeatmap(zoneData, view);
    renderMarkers(zoneData);
    updateStats(zoneData);
    renderZoneList(zoneData);
  } catch (err) {
    console.error('Refresh error:', err);
    showToast('⚠ Data error — check console', 4000);
  } finally {
    if (showLoader) loadingOverlay.classList.add('hidden');
  }
}

// ── Auto Refresh ──────────────────────────────────────────────────────────────

function startAutoRefresh() {
  clearInterval(autoRefreshId);
  autoRefreshId = setInterval(() => {
    if (!isSimulating) {
      currentHour = new Date().getHours();
      timeSlider.value = currentHour;
      syncTimeUI(currentHour);
      refresh(currentHour, currentView);
    }
  }, AUTO_REFRESH_MS);
}

// ── Time Slider ───────────────────────────────────────────────────────────────

function syncTimeUI(hour) {
  const { label, period } = formatHour(hour);
  timeLabel.textContent  = label;
  timePeriod.textContent = period;
  updateSliderFill(timeSlider);
}

timeSlider.addEventListener('input', () => {
  currentHour  = parseInt(timeSlider.value);
  isSimulating = currentHour !== new Date().getHours();
  syncTimeUI(currentHour);
  updateStatusBadge();

  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => refresh(currentHour, currentView), SLIDER_DEBOUNCE);
});

// Reset to current time button
const resetTimeBtn = document.getElementById('btn-reset-time');
if (resetTimeBtn) {
  resetTimeBtn.addEventListener('click', () => {
    currentHour  = new Date().getHours();
    isSimulating = false;
    timeSlider.value = currentHour;
    syncTimeUI(currentHour);
    updateStatusBadge();
    refresh(currentHour, currentView);
    showToast('Reset to current time');
  });
}

// ── View Buttons ──────────────────────────────────────────────────────────────

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    if (view === currentView) return;
    currentView = view;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderHeatmap(zoneData, currentView);
    showToast(`Switched to ${btn.querySelector('.btn-label').textContent}`);
  });
});

// ── Tooltip CSS ───────────────────────────────────────────────────────────────

const tooltipStyle = document.createElement('style');
tooltipStyle.textContent = `
  .custom-tooltip {
    background: rgba(10,10,10,0.9) !important;
    border: 1px solid rgba(255,255,255,0.15) !important;
    color: #f0f0f0 !important;
    font-family: 'Inter', sans-serif !important;
    font-size: 11px !important;
    font-weight: 500 !important;
    padding: 4px 10px !important;
    border-radius: 6px !important;
    box-shadow: none !important;
    white-space: nowrap !important;
    letter-spacing: 0.03em !important;
  }
  .custom-tooltip::before { display: none !important; }
`;
document.head.appendChild(tooltipStyle);

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async function bootstrap() {
  timeSlider.value = currentHour;
  syncTimeUI(currentHour);
  updateStatusBadge();
  initMap();
  await refresh(currentHour, currentView, true);
  startAutoRefresh();
})();
