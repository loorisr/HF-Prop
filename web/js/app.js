// HF Prop — UI. Static site: everything runs in the browser.
import { Pool, defaultPoolSize } from './pool.js';
import { toLocator, parsePosition, distanceKm, bearingDeg, greatCircle, nightPolygon } from './geo.js';
import { ssnFor } from './solar.js';
import { LAT_MAX, scaleFor, cssGradient, makeGrid, sample, drawTile } from './render.js';
import { drawHeatmap, drawMufChart, relColor } from './charts.js';

/* global L */

const BANDS = [
  { name: '160m', f: 1.85 }, { name: '80m', f: 3.6 }, { name: '60m', f: 5.36 }, { name: '40m', f: 7.1 },
  { name: '30m', f: 10.12 }, { name: '20m', f: 14.1 }, { name: '17m', f: 18.1 }, { name: '15m', f: 21.1 },
  { name: '12m', f: 24.93 }, { name: '10m', f: 28.3 },
];
// Required SNR is expressed in the given bandwidth (P.533 convention).
const MODES = {
  AM: { bw: 6000, snr: 20, label: 'AM (20 dB in 6 kHz)' },
  SSB: { bw: 3000, snr: 10, label: 'SSB (10 dB in 3 kHz)' },
  SSBDX: { bw: 3000, snr: 3, label: 'SSB, weak DX (3 dB in 3 kHz)' },
  FREEDV: { bw: 3000, snr: 0, label: 'FreeDV 700D (0 dB in 3 kHz)' },
  SSTV: { bw: 3000, snr: 15, label: 'SSTV (15 dB in 3 kHz)' },
  CW: { bw: 500, snr: 0, label: 'CW (0 dB in 500 Hz)' },
  CWWEAK: { bw: 500, snr: -6, label: 'CW, weak by ear (−6 dB in 500 Hz)' },
  RTTY: { bw: 2500, snr: -5, label: 'RTTY 45 bd (−5 dB in 2.5 kHz)' },
  PSK31: { bw: 2500, snr: -10, label: 'PSK31 (−10 dB in 2.5 kHz)' },
  OLIVIA: { bw: 2500, snr: -13, label: 'Olivia 8/500 (−13 dB in 2.5 kHz)' },
  FT4: { bw: 2500, snr: -16, label: 'FT4 (−16 dB in 2.5 kHz)' },
  FT8: { bw: 2500, snr: -20, label: 'FT8 (−20 dB in 2.5 kHz)' },
  JS8: { bw: 2500, snr: -24, label: 'JS8 normal (−24 dB in 2.5 kHz)' },
  JT65: { bw: 2500, snr: -25, label: 'JT65 (−25 dB in 2.5 kHz)' },
  WSPR: { bw: 2500, snr: -28, label: 'WSPR (−28 dB in 2.5 kHz)' },
};
// The engine models 4 patterns (0 iso, 1 ¼λ vertical, 2 ½λ dipole, 3 3-el Yagi) over
// average ground; other antennas reuse the closest pattern plus a gain/loss offset (dB).
// `h`: default height applied when the antenna is picked; `noHeight`: height is ignored.
const ANTS = [
  { id: 'iso', type: 0, label: 'Isotropic (0 dBi)', noHeight: true },
  { id: 'vertical', type: 1, label: '¼λ vertical, good radials', noHeight: true },
  { id: 'vertical-poor', type: 1, extra: -4, label: 'Vertical, few radials', noHeight: true },
  { id: 'mobile', type: 1, extra: -10, label: 'Mobile whip', noHeight: true },
  { id: 'magloop', type: 1, extra: -5, label: 'Magnetic loop', noHeight: true },
  { id: 'dipole', type: 2, label: '½λ dipole' },
  { id: 'invv', type: 2, extra: -1, label: 'Inverted-V' },
  { id: 'efhw', type: 2, extra: -1.5, label: 'End-fed half-wave' },
  { id: 'longwire', type: 2, extra: -3, label: 'Random / long wire' },
  { id: 'nvis', type: 4, h: 4, label: 'NVIS dipole (low)' },
  { id: 'yagi2', type: 3, extra: -2.5, label: '2-el Yagi / hexbeam' },
  { id: 'yagi', type: 3, label: '3-el Yagi' },
  { id: 'quad', type: 3, extra: 0.5, label: '2-el quad' },
  { id: 'yagi5', type: 3, extra: 2.5, label: '5-el Yagi' },
];
const antById = (id) => ANTS.find((a) => a.id === id) || ANTS[0];
const MAP_FREQ_MUF = 14.1; // MUF/FOT do not depend on the operating frequency

const $ = (id) => document.getElementById(id);
const dark = matchMedia('(prefers-color-scheme: dark)');

/* ---------------- state ---------------- */
const now = new Date();
const defaults = {
  view: 'path',
  tx: [48.85, 2.35],
  rx: [40.71, -74.0],
  ym: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
  hour: now.getUTCHours(),
  ssn: 100, ssnAuto: true,
  power: 100, mode: 'SSB',
  antTx: 'dipole', hTx: 10, antRx: 'dipole', hRx: 10, noise: 1,
  aimTx: -1, aimRx: -1, // antenna heading in degrees true; -1 = always aimed at the other station
  mapKind: 'fot', mapBand: '20m', mapStyle: 'bands', fine: true,
};
const state = loadState();

function loadState() {
  let s = { ...defaults };
  try { Object.assign(s, JSON.parse(localStorage.getItem('hfprop-state') || '{}')); } catch { /* */ }
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    const pos = (k) => { const v = h.get(k); const p = v && parsePosition(v); return p || null; };
    if (pos('tx')) s.tx = pos('tx');
    if (pos('rx')) s.rx = pos('rx');
    for (const k of ['ym', 'mode', 'antTx', 'antRx', 'mapKind', 'mapBand', 'mapStyle', 'view']) if (h.get(k)) s[k] = h.get(k);
    for (const k of ['hour', 'ssn', 'power', 'hTx', 'hRx', 'noise', 'aimTx', 'aimRx']) if (h.get(k) && Number.isFinite(+h.get(k))) s[k] = +h.get(k);
    if (h.get('ssn')) s.ssnAuto = false;
  } catch { /* */ }
  return normalize(s);
}

/** Replace anything invalid (old localStorage, hand-edited URL) by its default. */
function normalize(s) {
  const pick = (k, ok) => { if (!ok(s[k])) s[k] = defaults[k]; };
  const num = (k, lo, hi, int = false) => {
    const v = Number(s[k]);
    s[k] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, int ? Math.round(v) : v)) : defaults[k];
  };
  const isPos = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
  pick('view', (v) => v === 'path' || v === 'map');
  pick('tx', isPos);
  if (s.rx !== null) pick('rx', isPos);
  pick('ym', (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v));
  pick('mode', (v) => !!MODES[v]);
  pick('antTx', (v) => ANTS.some((a) => a.id === v));
  pick('antRx', (v) => ANTS.some((a) => a.id === v));
  pick('mapKind', (v) => ['fot', 'muf', 'rel', 'snr'].includes(v));
  pick('mapBand', (v) => BANDS.some((b) => b.name === v));
  pick('mapStyle', (v) => v === 'bands' || v === 'gradient');
  num('hour', 0, 23, true);
  num('ssn', 1, 300);
  num('power', 1, 10000);
  num('hTx', 1, 100); num('hRx', 1, 100);
  num('noise', 0, 3, true);
  for (const k of ['aimTx', 'aimRx']) {
    const v = Number(s[k]);
    s[k] = Number.isFinite(v) && v >= 0 ? ((Math.round(v) % 360) + 360) % 360 : -1;
  }
  s.ssnAuto = s.ssnAuto !== false;
  s.fine = s.fine !== false;
  return s;
}
function saveState() {
  try { localStorage.setItem('hfprop-state', JSON.stringify(state)); } catch { /* */ }
  const h = new URLSearchParams({
    view: state.view, tx: state.tx.map((v) => v.toFixed(3)).join(','),
    rx: state.rx ? state.rx.map((v) => v.toFixed(3)).join(',') : '', ym: state.ym, hour: state.hour,
    mode: state.mode, power: state.power, antTx: state.antTx, hTx: state.hTx, antRx: state.antRx, hRx: state.hRx,
    aimTx: state.aimTx, aimRx: state.aimRx, noise: state.noise, mapKind: state.mapKind, mapBand: state.mapBand, mapStyle: state.mapStyle,
  });
  if (!state.ssnAuto) h.set('ssn', state.ssn);
  history.replaceState(null, '', '#' + h.toString());
}

function engineCfg() {
  const [year, month] = state.ym.split('-').map(Number);
  const m = MODES[state.mode];
  const ant = (id, h, aim) => {
    const a = antById(id);
    return { type: a.type, height: h, heading: a.noHeight ? -1 : aim, extra: a.extra || 0 };
  };
  return {
    month,
    antFreqs: BANDS.map((b) => b.f),
    params: { ssn: Math.max(1, Math.min(300, Math.round(state.ssn))), powerW: state.power, bw: m.bw, snrReq: m.snr, noise: state.noise, year },
    antTx: ant(state.antTx, state.hTx, state.aimTx),
    antRx: ant(state.antRx, state.hRx, state.aimRx),
  };
}

/* ---------------- map ---------------- */
const map = L.map('map', { worldCopyJump: true, minZoom: 1, zoomControl: true, attributionControl: true })
  .setView([35, 0], 2);
let tiles = null;
function setTiles() {
  tiles?.remove();
  // OpenStreetMap standard tiles (no API key). Dark mode is done with a CSS filter (see app.css).
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 10,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  tiles.bringToBack();
  map.getContainer().classList.toggle('map-dark', dark.matches);
}
setTiles();
dark.addEventListener('change', () => { setTiles(); renderPath(); renderMapFromCache(); });

const icon = (cls) => L.divIcon({ className: '', html: `<div class="station-icon ${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
const txMarker = L.marker(state.tx, { icon: icon('tx'), draggable: true, zIndexOffset: 1000 }).addTo(map)
  .bindTooltip('TX', { permanent: true, direction: 'right', offset: [8, 0], className: 'station-label' });
const rxMarker = L.marker(state.rx || [0, 0], { icon: icon('rx'), draggable: true }).bindTooltip('RX', { permanent: true, direction: 'right', offset: [8, 0], className: 'station-label' });
const gcLine = L.polyline([], { color: getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim() || '#2a78d6', weight: 2, opacity: 0.9, interactive: false }).addTo(map);
const night = L.polygon([], { stroke: false, fillColor: '#000', fillOpacity: 0.12, interactive: false }).addTo(map);

// Coverage layer: tiles drawn on demand from the latest grid, so it stays sharp
// at every zoom and repeats on wrapped world copies. Own pane, above the basemap
// but outside .leaflet-tile-pane (whose dark-mode CSS filter would invert it).
map.createPane('coverage');
map.getPane('coverage').style.zIndex = 350;
map.getPane('coverage').style.pointerEvents = 'none';
let mapScale = null; // current color scale for the coverage layer
const TILE = 256;
const CoverageLayer = L.GridLayer.extend({
  createTile(coords) {
    const c = document.createElement('canvas');
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = TILE * ratio;
    drawTile(c, coords, TILE, mapField(), mapScale);
    return c;
  },
  /** Redraw the existing tiles in place (no flash while the grid refines). */
  repaint() {
    const f = mapField();
    for (const t of Object.values(this._tiles || {})) drawTile(t.el, this._wrapCoords(t.coords), TILE, f, mapScale);
  },
});
const coverage = new CoverageLayer({ pane: 'coverage', tileSize: TILE, updateWhenZooming: false, keepBuffer: 1 });

// Map view: a tap/click pins a point and freezes the readout on it.
const pinMarker = L.circleMarker([0, 0], { radius: 6, weight: 2, color: '#fff', fillColor: '#111', fillOpacity: 0.9, interactive: false });
let pinned = null;

txMarker.on('dragend', () => { setPos('tx', fixLon(txMarker.getLatLng())); });
rxMarker.on('dragend', () => { setPos('rx', fixLon(rxMarker.getLatLng())); });
map.on('click', (e) => {
  if (state.view === 'path') {
    const which = document.querySelector('input[name=tapset]:checked').value;
    setPos(which, fixLon(e.latlng));
  } else if (pinned && map.latLngToContainerPoint(pinned).distanceTo(e.containerPoint) < 12) {
    unpin(); // tap on the pin again releases it
  } else {
    pinned = e.latlng;
    pinMarker.setLatLng(pinned).addTo(map);
    hudAt(pinned);
  }
});
map.on('mousemove', (e) => { if (state.view === 'map' && !pinned) hudAt(e.latlng); });
function unpin() {
  pinned = null;
  pinMarker.remove();
  hud('Hover to read values, tap to pin a point.');
}

function fixLon(ll) { let lon = ((ll.lng + 180) % 360 + 360) % 360 - 180; return [ll.lat, lon]; }

function setPos(which, pos) {
  state[which] = [Math.max(-89.9, Math.min(89.9, pos[0])), pos[1]];
  syncInputs();
  updateGeometry();
  saveState();
  schedule(which === 'tx' ? ['path', 'map'] : ['path']);
}

function updateGeometry() {
  txMarker.setLatLng(state.tx);
  if (state.rx && state.view === 'path') {
    rxMarker.setLatLng(state.rx).addTo(map);
    gcLine.setLatLngs(greatCircle(state.tx, state.rx));
  } else {
    rxMarker.remove();
    gcLine.setLatLngs([]);
  }
  const month = +state.ym.split('-')[1];
  night.setLatLngs(nightPolygon(month, state.hour + 0.5));
}

/* ---------------- controls ---------------- */
function fillSelect(sel, items) {
  sel.innerHTML = items.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}
fillSelect($('mode'), Object.entries(MODES).map(([k, m]) => [k, m.label]));
fillSelect($('ant-tx'), ANTS.map((a) => [a.id, a.label]));
fillSelect($('ant-rx'), ANTS.map((a) => [a.id, a.label]));
fillSelect($('map-band'), BANDS.map((b) => [b.name, `${b.name} (${b.f} MHz)`]));

function syncInputs() {
  if (document.activeElement !== $('tx-pos')) $('tx-pos').value = fmtPos(state.tx);
  if (document.activeElement !== $('rx-pos')) $('rx-pos').value = state.rx ? fmtPos(state.rx) : '';
  $('month').value = state.ym;
  $('ssn').value = Math.round(state.ssn);
  $('ssn-auto').checked = state.ssnAuto;
  $('ssn').disabled = state.ssnAuto;
  $('hour').value = state.hour;
  $('hour-out').textContent = `${String(state.hour).padStart(2, '0')}:00`;
  $('power').value = state.power;
  $('mode').value = state.mode;
  $('ant-tx').value = state.antTx; $('h-tx').value = state.hTx;
  $('ant-rx').value = state.antRx; $('h-rx').value = state.hRx;
  $('h-tx').disabled = !!antById(state.antTx).noHeight;
  $('h-rx').disabled = !!antById(state.antRx).noHeight;
  // Heading only matters for directional antennas (omni ones have noHeight).
  for (const [id, ant, aim] of [['aim-tx', state.antTx, state.aimTx], ['aim-rx', state.antRx, state.aimRx]]) {
    $(id).closest('.row').style.display = antById(ant).noHeight ? 'none' : '';
    if (document.activeElement !== $(id)) $(id).value = aim >= 0 ? aim : '';
  }
  $('noise').value = state.noise;
  $('map-kind').value = state.mapKind;
  $('map-band').value = state.mapBand;
  $('map-style').value = state.mapStyle;
  // Band only matters for reliability/SNR; MUF and FOT don't depend on the operating frequency.
  $('map-band').closest('.row').style.display = ['rel', 'snr'].includes(state.mapKind) ? '' : 'none';
  $('map-fine').checked = state.fine;
  $('tab-path').setAttribute('aria-selected', state.view === 'path');
  $('tab-map').setAttribute('aria-selected', state.view === 'map');
  document.body.className = 'mode-' + state.view;
}
const fmtPos = (p) => `${toLocator(p[0], p[1])} (${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;

function bindPos(id, which) {
  const inp = $(id);
  const apply = () => {
    const p = parsePosition(inp.value.replace(/\(.*\)/, '').trim()) || parsePosition((inp.value.match(/\(([^)]*)\)/) || [])[1]);
    if (p) { inp.classList.remove('bad'); setPos(which, p); if (which === 'rx' || state.view === 'map') map.panTo(p); }
    else inp.classList.add('bad');
  };
  inp.addEventListener('change', apply);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { apply(); inp.blur(); } });
}
bindPos('tx-pos', 'tx');
bindPos('rx-pos', 'rx');

$('tx-gps').addEventListener('click', () => {
  if (!navigator.geolocation) return hud('Geolocation is not available in this browser.');
  hud('Locating…');
  navigator.geolocation.getCurrentPosition(
    (p) => { setPos('tx', [p.coords.latitude, p.coords.longitude]); map.setView(state.tx, Math.max(map.getZoom(), 3)); },
    (e) => hud('Location unavailable: ' + e.message), { timeout: 10000 });
});

const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
const numIn = (v, lo, hi, d) => (Number.isFinite(+v) && v !== '' ? Math.max(lo, Math.min(hi, +v)) : d);
on('month', 'change', () => { if ($('month').value) { state.ym = $('month').value; afterChange(['path', 'map']); if (state.ssnAuto) refreshSsn(); } });
on('ssn', 'change', () => { state.ssn = numIn($('ssn').value, 1, 300, 100); afterChange(['path', 'map']); });
on('ssn-auto', 'change', () => { state.ssnAuto = $('ssn-auto').checked; syncInputs(); if (state.ssnAuto) refreshSsn(); else $('ssn-src').textContent = 'Manual SSN.'; saveState(); });
on('hour', 'input', () => { state.hour = +$('hour').value; afterChange(['hour']); });
on('hour-now', 'click', () => { state.hour = new Date().getUTCHours(); afterChange(['hour']); });
on('power', 'change', () => { state.power = numIn($('power').value, 1, 10000, 100); afterChange(['path', 'map']); });
on('mode', 'change', () => { state.mode = $('mode').value; afterChange(['path', 'map']); });
on('ant-tx', 'change', () => { state.antTx = $('ant-tx').value; if (antById(state.antTx).h) state.hTx = antById(state.antTx).h; afterChange(['path', 'map']); });
on('ant-rx', 'change', () => { state.antRx = $('ant-rx').value; if (antById(state.antRx).h) state.hRx = antById(state.antRx).h; afterChange(['path', 'map']); });
on('h-tx', 'change', () => { state.hTx = numIn($('h-tx').value, 1, 100, 10); afterChange(['path', 'map']); });
on('h-rx', 'change', () => { state.hRx = numIn($('h-rx').value, 1, 100, 10); afterChange(['path', 'map']); });
const aimIn = (v) => (String(v).trim() === '' || !Number.isFinite(+v) ? -1 : ((Math.round(+v) % 360) + 360) % 360);
on('aim-tx', 'change', () => { state.aimTx = aimIn($('aim-tx').value); afterChange(['path', 'map']); });
on('aim-rx', 'change', () => { state.aimRx = aimIn($('aim-rx').value); afterChange(['path', 'map']); });
on('noise', 'change', () => { state.noise = +$('noise').value; afterChange(['path', 'map']); });
on('map-kind', 'change', () => { state.mapKind = $('map-kind').value; afterChange(['map']); });
on('map-band', 'change', () => { state.mapBand = $('map-band').value; afterChange(['map']); });
on('map-style', 'change', () => { state.mapStyle = $('map-style').value; syncInputs(); saveState(); renderMapFromCache(); });
on('map-fine', 'change', () => { state.fine = $('map-fine').checked; afterChange(['map']); });
on('tab-path', 'click', () => setView('path'));
on('tab-map', 'click', () => setView('map'));

function setView(v) {
  state.view = v;
  afterChange([]);
  if (v === 'map') {
    if (lastGrid) coverage.addTo(map);
    $('legend').hidden = !lastGrid;
    schedule(['map']);
    hud('Hover to read values, tap to pin a point.');
  } else { mapGen++; pool.cancelQueued((t) => t.type === 'grid'); progress(null); coverage.remove(); pinned = null; pinMarker.remove(); $('legend').hidden = true; hud('Tap the map to set the ' + (document.querySelector('input[name=tapset]:checked').value === 'tx' ? 'transmitter.' : 'receiver.')); requestAnimationFrame(renderPath); schedule(['path']); }
  setTimeout(() => map.invalidateSize(), 50);
}

function afterChange(what) {
  syncInputs();
  updateGeometry();
  saveState();
  if (what.includes('hour')) {
    renderPath();
    schedule(['map']);
  } else {
    schedule(what);
  }
}

/* ---------------- HUD ---------------- */
function hud(text) { $('hud-text').textContent = text; }
function progress(frac) {
  const p = $('progress');
  if (frac === null) { p.hidden = true; return; }
  p.hidden = false;
  p.firstElementChild.style.width = (frac * 100).toFixed(0) + '%';
}

/* ---------------- solar ---------------- */
async function refreshSsn() {
  const ym = state.ym;
  const [y, m] = ym.split('-').map(Number);
  $('ssn-src').textContent = 'Fetching SSN from NOAA…';
  try {
    const r = await ssnFor(y, m);
    // Ignore a late answer for a month the user has already left.
    if (!state.ssnAuto || state.ym !== ym) return;
    state.ssn = Math.max(1, Math.round(r.ssn));
    $('ssn-src').textContent = `NOAA SWPC ${r.src} smoothed SSN for ${r.tag}.`;
    afterChange(['path', 'map']);
  } catch (e) {
    if (state.ym !== ym) return;
    $('ssn-src').innerHTML = '<span class="bad">NOAA data unreachable.</span> Uncheck Auto to enter the SSN yourself.';
  }
}

/* ---------------- compute ---------------- */
const pool = new Pool(defaultPoolSize());

// Download a month's data once into the Cache Storage shared with the
// workers, so N workers don't each download the same 3.6 MB.
const cachedMonths = new Map();
function ensureCached(month) {
  if (!cachedMonths.has(month)) {
    cachedMonths.set(month, (async () => {
      if (!('caches' in self)) return;
      const mm = String(month).padStart(2, '0');
      const files = ['data/P1239-3.txt.gz', `data/ion${mm}.pk.gz`, `data/COEFF${mm}W.txt.gz`];
      const cache = await caches.open('hfprop-data-v1');
      const todo = [];
      for (const f of files) {
        const url = new URL(f, location.href).href;
        if (!(await cache.match(url))) todo.push(url);
      }
      if (!todo.length) return;
      hud(`Downloading ITU data for month ${mm} (≈3.6 MB, cached afterwards)…`);
      await Promise.all(todo.map(async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
        await cache.put(url, r);
      }));
      hud('Data ready.');
    })().catch((e) => { cachedMonths.delete(month); console.warn('prefetch failed', e); }));
  }
  return cachedMonths.get(month);
}
let pending = new Set();
let timer = 0;
function schedule(what) {
  what.forEach((w) => pending.add(w));
  clearTimeout(timer);
  timer = setTimeout(() => {
    const p = pending; pending = new Set();
    if (p.has('path') && state.view === 'path') computePath();
    if (p.has('map') && state.view === 'map') computeMap();
  }, 120);
}

let pathData = null; // [24][bands] results
let pathGen = 0;
async function computePath() {
  if (!state.rx) return;
  const gen = ++pathGen;
  const cfg = engineCfg();
  $('path-summary').textContent = 'Computing…';
  await ensureCached(cfg.month);
  if (gen !== pathGen) return;
  try {
    const t0 = performance.now();
    const data = await pool.run({ type: 'p2p', cfg, tx: state.tx, rx: state.rx, freqs: BANDS.map((b) => b.f) });
    if (gen !== pathGen) return;
    pathData = { data, ms: performance.now() - t0 };
    renderPath();
  } catch (e) {
    if (gen === pathGen) $('path-summary').innerHTML = `<span class="bad">Prediction failed: ${e.message}</span>`;
  }
}

function status(rel) {
  if (rel >= 75) return ['good', 'Open'];
  if (rel >= 40) return ['fair', 'Fair'];
  if (rel >= 10) return ['poor', 'Poor'];
  return ['closed', 'Closed'];
}

function renderPath() {
  if (!pathData || state.view !== 'path') return;
  const { data } = pathData;
  const h = state.hour;
  const row = data[h];
  const any = row.find(Boolean);
  const d = distanceKm(state.tx, state.rx);
  const brg = bearingDeg(state.tx, state.rx);
  let best = -1;
  row.forEach((r, i) => { if (r && (best < 0 || r.rel > row[best].rel + 0.5 || (Math.abs(r.rel - row[best].rel) <= 0.5 && r.snr > row[best].snr))) best = i; });
  const bestRes = best >= 0 ? row[best] : null;
  const hops = any && d < 7000 && any.hopsF2 < 50 ? ` · ${any.hopsF2}F2 lowest mode` : (d >= 9000 ? ' · long-path model (> 9000 km)' : '');
  $('path-summary').innerHTML = (bestRes && bestRes.rel >= 10
    ? `<span class="hero">${BANDS[best].name} · ${bestRes.rel.toFixed(0)}%</span>Best band at ${String(h).padStart(2, '0')}:00 UTC`
    : `<span class="hero">No band open</span>at ${String(h).padStart(2, '0')}:00 UTC with ${state.mode}`) +
    `<br>${Math.round(d).toLocaleString()} km · ${Math.round(brg)}° · MUF ${fmt1(any?.muf50)} MHz · FOT ${fmt1(any?.muf90)} MHz${hops}`;

  const req = MODES[state.mode].snr;
  $('band-table').innerHTML = `<table class="bands"><thead><tr><th>Band</th><th>Reliability</th><th class="num">SNR</th><th class="num">Margin</th><th>Status</th></tr></thead><tbody>` +
    BANDS.map((b, i) => {
      const r = row[i];
      if (!r) return `<tr><td>${b.name}</td><td colspan="4" class="hint">—</td></tr>`;
      const [cls, lbl] = status(r.rel);
      return `<tr class="${i === best && r.rel >= 10 ? 'best' : ''}"><td>${b.name}</td>` +
        `<td><span class="relbar" style="width:${Math.max(2, r.rel * 0.6)}px;background:${relColor(Math.max(r.rel, 30), dark.matches)}"></span>${r.rel.toFixed(0)}%</td>` +
        `<td class="num">${r.snr.toFixed(0)} dB</td><td class="num">${r.snr - req >= 0 ? '+' : ''}${(r.snr - req).toFixed(0)}</td>` +
        `<td><span class="status ${cls}">${lbl}</span></td></tr>`;
    }).reverse().join('') + '</tbody></table>';

  drawHeatmap($('heatmap'), {
    bands: BANDS, data, hour: h, dark: dark.matches,
    onPickHour: (hh) => { state.hour = hh; afterChange(['hour']); },
  });
  const ramp = Array.from({ length: 11 }, (_, i) => relColor(i * 10 || 1, dark.matches));
  $('heat-ramp').style.background = `linear-gradient(to right, ${ramp.join(',')})`;
  drawMufChart($('mufchart'), {
    mufs: data.map((r) => r.find(Boolean)?.muf50 ?? NaN),
    fots: data.map((r) => r.find(Boolean)?.muf90 ?? NaN),
    hour: h, bands: BANDS,
  });
}
const fmt1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

/* ---- coverage map: progressive 12° → 6° → 3° → 1.5° ---- */
let mapGen = 0;
// Computed points per configuration, most recently used last: going back to an
// hour or a band already seen is instant.
const GRID_CACHE_SIZE = 6;
const gridCaches = new Map(); // key -> Map("lat,lon" -> Float32Array[4])
function gridCacheFor(key) {
  let pts = gridCaches.get(key);
  if (pts) gridCaches.delete(key);
  else pts = new Map();
  gridCaches.set(key, pts);
  while (gridCaches.size > GRID_CACHE_SIZE) gridCaches.delete(gridCaches.keys().next().value);
  return pts;
}
let lastGrid = null; // { grid, raw: Float32Array[n*4] } for HUD + re-render

function mapFreq() {
  return ['rel', 'snr'].includes(state.mapKind) ? BANDS.find((b) => b.name === state.mapBand).f : MAP_FREQ_MUF;
}

async function computeMap() {
  const gen = ++mapGen;
  pool.cancelQueued((t) => t.type === 'grid');
  const cfg = engineCfg();
  await ensureCached(cfg.month);
  if (gen !== mapGen) return;
  const freq = mapFreq();
  const key = JSON.stringify([cfg, state.tx, state.hour, freq]);
  const cache = gridCacheFor(key);
  const levels = state.fine ? [12, 6, 3, 1.5] : [12, 6, 3];
  const t0 = performance.now();
  let done = 0;
  const total = levels.reduce((s, st) => s + makeGrid(st).nLat * makeGrid(st).nLon, 0);
  progress(0);
  for (const step of levels) {
    const grid = makeGrid(step);
    const missing = [];
    for (let i = 0; i < grid.nLat; i++) for (let j = 0; j < grid.nLon; j++) {
      const k = grid.lat(i).toFixed(2) + ',' + grid.lon(j).toFixed(2);
      if (!cache.has(k)) missing.push(grid.lat(i), grid.lon(j));
    }
    const chunk = 2 * Math.max(64, Math.ceil(missing.length / 2 / (pool.size * 4)));
    const jobs = [];
    for (let s = 0; s < missing.length; s += chunk) {
      const pts = Float64Array.from(missing.slice(s, s + chunk));
      jobs.push(pool.run({ type: 'grid', cfg, tx: state.tx, hour: state.hour, freqs: [freq], points: pts })
        .then((res) => {
          // Keep finished results even if this run was superseded: they stay valid for `key`.
          for (let p = 0; p < pts.length / 2; p++) {
            cache.set(pts[2 * p].toFixed(2) + ',' + pts[2 * p + 1].toFixed(2), res.subarray(p * 4, p * 4 + 4));
          }
          if (gen !== mapGen) return;
          done += pts.length / 2;
          progress(Math.min(1, (done + (grid.nLat * grid.nLon - missing.length / 2)) / total));
        }));
    }
    try { await Promise.all(jobs); } catch (e) { if (e.message === 'cancelled' || gen !== mapGen) return; hud('Map failed: ' + e.message); progress(null); return; }
    if (gen !== mapGen) return;
    const raw = new Float32Array(grid.nLat * grid.nLon * 4);
    for (let i = 0; i < grid.nLat; i++) for (let j = 0; j < grid.nLon; j++) {
      const v = cache.get(grid.lat(i).toFixed(2) + ',' + grid.lon(j).toFixed(2));
      if (v) raw.set(v, (i * grid.nLon + j) * 4);
    }
    lastGrid = { grid, raw };
    renderMapFromCache();
    hud(`${grid.step}° grid ready (${((performance.now() - t0) / 1000).toFixed(1)} s, ${pool.size} workers)` + (step !== levels[levels.length - 1] ? ' — refining…' : ''));
    await new Promise((r) => setTimeout(r, 0));
  }
  progress(null);
}

// lastGrid.raw holds [muf50, muf90, snr, rel] per grid point.
const KIND_INDEX = { muf: 0, fot: 1, snr: 2, rel: 3 };
const mapField = (kind = state.mapKind) =>
  (lastGrid ? { grid: lastGrid.grid, values: lastGrid.raw, stride: 4, off: KIND_INDEX[kind] } : null);

function renderMapFromCache() {
  if (!lastGrid || state.view !== 'map') return;
  const scale = scaleFor(state.mapKind, { dark: dark.matches, snrReq: MODES[state.mode].snr, style: state.mapStyle, bands: BANDS });
  mapScale = scale;
  if (map.hasLayer(coverage)) coverage.repaint();
  else coverage.addTo(map); // draws its tiles from the current grid and scale
  if (pinned) hudAt(pinned);
  const band = ['rel', 'snr'].includes(state.mapKind) ? ` · ${state.mapBand}` : '';
  const head = `<div class="title">${scale.label}${band}</div>` +
    `<div class="hint">${String(state.hour).padStart(2, '0')}:00 UTC · ${state.mode} · ${state.power} W · SSN ${Math.round(state.ssn)}</div>`;
  if (scale.discrete) {
    const rgb = (c) => `rgb(${c.join(',')})`;
    // Highest class first, so the list reads like the band table.
    const items = scale.classes.map((c) => `<li><i style="background:${rgb(c.color)}"></i>${c.label}` +
      (c.sub ? `<span class="sub">${c.sub}</span>` : '') + '</li>').reverse().join('');
    $('legend').innerHTML = head + `<ul class="swatches${scale.bandsLegend ? ' cols2' : ''}">${items}</ul>` +
      (state.mapKind === 'snr' ? '<div class="hint">0 dB = required SNR for the mode</div>' : '') +
      (scale.bandsLegend ? '<div class="hint">No color: below 160m</div>' : '');
  } else {
    const ticks = scale.ticks.map((t) => {
      const pos = ((t - scale.min) / (scale.max - scale.min)) * 100;
      return `<span class="${pos <= 0 ? 'start' : pos >= 100 ? 'end' : ''}" style="left:${pos}%">${t}</span>`;
    }).join('');
    $('legend').innerHTML = head +
      `<div class="bar" style="background:${cssGradient(scale)}"></div><div class="ticks">${ticks}</div>` +
      `<div class="hint" style="text-align:right">${scale.unit}${state.mapKind === 'snr' ? ' (0 = required SNR)' : ''}</div>`;
  }
  $('legend').hidden = false;
}

function bestBandBelow(f) {
  let b = null;
  for (const x of BANDS) if (x.f <= f) b = x;
  return b;
}

function hudAt(ll) {
  if (!lastGrid) return;
  const [lat, lon] = fixLon(ll);
  if (Math.abs(lat) > LAT_MAX) return;
  const v = {};
  for (const [k, off] of Object.entries(KIND_INDEX)) v[k] = sample(lastGrid.grid, lastGrid.raw, lat, lon, 4, off);
  const loc = toLocator(lat, lon, 4);
  const d = Math.round(distanceKm(state.tx, [lat, lon]));
  let txt = `${loc} · ${d.toLocaleString()} km · MUF ${fmt1(v.muf)} · FOT ${fmt1(v.fot)} MHz`;
  const bb = bestBandBelow(v.fot);
  if (state.mapKind === 'fot' || state.mapKind === 'muf') txt += bb ? ` → best ≈ ${bb.name}` : ' → below 160m';
  else txt += ` · ${state.mapBand}: ${Number.isFinite(v.rel) ? v.rel.toFixed(0) + '%' : '—'}, SNR ${Number.isFinite(v.snr) ? v.snr.toFixed(0) + ' dB' : '—'}`;
  hud((pinned ? '📍 ' : '') + txt);
}

/* ---------------- boot ---------------- */
syncInputs();
updateGeometry();
setView(state.view);
if (state.ssnAuto) refreshSsn(); else $('ssn-src').textContent = 'Manual SSN.';
schedule(['path', 'map']);
// Warm all workers (decode the month's data) once the download is cached.
ensureCached(engineCfg().month).then(() => {
  for (let i = 0; i < pool.size; i++) pool.run({ type: 'warm', cfg: engineCfg() }).catch(() => {});
});
let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderPath, 150); });
