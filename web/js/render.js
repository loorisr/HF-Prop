// Coverage-map rendering: interpolates a lat/lon grid into a Web-Mercator
// image for L.imageOverlay, plus the color scales shared with the legend.

export const LAT_MAX = 84;

// Sequential single-hue blue ramp (light -> dark), from the design palette.
const BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5',
  '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const RED = '#e34948';
const BLUEPOLE = '#2a78d6';

function hex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
const BLUE_RGB = BLUE.map(hex);

function rampAt(rgbList, t) {
  t = Math.max(0, Math.min(1, t)) * (rgbList.length - 1);
  const i = Math.min(rgbList.length - 2, Math.floor(t));
  const f = t - i;
  const a = rgbList[i], b = rgbList[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// One distinct, ordered hue per amateur band (low → high frequency).
const BAND_COLORS = ['#6a3d9a', '#2b4fb3', '#1f97d4', '#14a38b', '#43a843', '#a5c92a',
  '#f2c40f', '#f08c12', '#e2512b', '#c21a5c'];
const STATUS = { poor: '#ec835a', fair: '#fab219', good: '#0ca30c' };

/**
 * Discrete (classed) scale. Each class: { label, color: [r,g,b] }.
 * classOf(v) -> class index or -1 (transparent).
 */
function discrete({ classes, classOf, alpha, ...rest }) {
  return {
    ...rest, classes, classOf, alpha, discrete: true,
    color(v) {
      const k = classOf(v);
      if (k < 0) return null;
      const c = classes[k].color;
      return [c[0], c[1], c[2], alpha];
    },
  };
}

function discreteScaleFor(kind, { dark, snrReq, bands }) {
  if (kind === 'rel') {
    const cls = [
      { label: 'Poor (10–40 %)', color: hex(STATUS.poor) },
      { label: 'Fair (40–75 %)', color: hex(STATUS.fair) },
      { label: 'Open (≥ 75 %)', color: hex(STATUS.good) },
    ];
    return discrete({
      label: 'Reliability', unit: '%', classes: cls, alpha: 0.55,
      classOf: (v) => (!(v >= 10) ? -1 : v < 40 ? 0 : v < 75 ? 1 : 2),
    });
  }
  if (kind === 'snr') {
    // 5 dB steps of margin around the required SNR, diverging red → blue.
    const edges = [-15, -10, -5, 0, 5, 10, 15];
    const lo = hex(RED), hi = hex(BLUEPOLE);
    const neutral = dark ? hex('#383835') : hex('#f0efec');
    const mix = (m) => {
      const pole = m < 0 ? lo : hi, t = Math.min(1, Math.abs(m));
      return neutral.map((n, i) => Math.round(n + (pole[i] - n) * t));
    };
    const cls = [];
    for (let k = 0; k <= edges.length; k++) {
      const a = edges[k - 1], b = edges[k];
      const mid = a === undefined ? -17.5 : b === undefined ? 17.5 : (a + b) / 2;
      const label = a === undefined ? `< ${b} dB` : b === undefined ? `≥ +${a} dB`
        : `${a > 0 ? '+' : ''}${a} … ${b > 0 ? '+' : ''}${b} dB`;
      cls.push({ label, color: mix(mid / 17.5) });
    }
    return discrete({
      label: 'SNR margin vs. required', unit: 'dB', classes: cls, alpha: 0.62, edges,
      classOf(v) {
        if (!Number.isFinite(v)) return -1;
        const m = v - snrReq;
        let k = 0;
        while (k < edges.length && m >= edges[k]) k++;
        return k;
      },
    });
  }
  // 'muf' / 'fot': class = highest band at or below the frequency.
  const cls = bands.map((b, i) => ({ label: b.name, sub: `≥ ${b.f} MHz`, color: hex(BAND_COLORS[i % BAND_COLORS.length]) }));
  return discrete({
    label: kind === 'fot' ? 'Best band (from FOT)' : 'Highest band below MUF', unit: 'MHz', classes: cls, alpha: 0.55,
    bandsLegend: true,
    classOf(v) {
      if (!(v > 0)) return -1;
      let k = -1;
      for (let i = 0; i < bands.length; i++) if (bands[i].f <= v) k = i;
      return k;
    },
  });
}

/**
 * Color scale for a map kind. `dark` flips the sequential ramp so that
 * "more" is always the higher-contrast end against the basemap.
 * style: 'bands' (discrete classes) or 'gradient' (continuous).
 * Returns { color(v) -> [r,g,b,a] | null, unit, label, ... }.
 */
export function scaleFor(kind, { dark, snrReq = 0, style = 'gradient', bands = [] }) {
  if (style === 'bands') return discreteScaleFor(kind, { dark, snrReq, bands });
  const seq = dark ? BLUE_RGB.slice().reverse() : BLUE_RGB;
  const neutral = dark ? hex('#383835') : hex('#f0efec');
  if (kind === 'rel') {
    return {
      label: 'Reliability', unit: '%', min: 0, max: 100, ticks: [0, 25, 50, 75, 100],
      color(v) {
        if (!(v >= 5)) return null;
        const c = rampAt(seq, v / 100);
        return [c[0], c[1], c[2], 0.2 + 0.6 * Math.min(1, v / 40)];
      },
      css: seq,
    };
  }
  if (kind === 'snr') {
    // Diverging around the mode's required SNR: red below, blue above.
    const lo = hex(RED), hi = hex(BLUEPOLE);
    return {
      label: 'SNR margin vs. required', unit: 'dB', min: -20, max: 20, ticks: [-20, -10, 0, 10, 20],
      color(v) {
        if (!Number.isFinite(v)) return null;
        const m = Math.max(-20, Math.min(20, v - snrReq)) / 20;
        const pole = m < 0 ? lo : hi;
        const t = Math.abs(m);
        return [neutral[0] + (pole[0] - neutral[0]) * t, neutral[1] + (pole[1] - neutral[1]) * t,
          neutral[2] + (pole[2] - neutral[2]) * t, 0.62];
      },
      diverging: [RED, dark ? '#383835' : '#f0efec', BLUEPOLE],
    };
  }
  // 'muf' and 'fot': MHz
  return {
    label: kind === 'fot' ? 'Best frequency (FOT)' : 'MUF (median)', unit: 'MHz', min: 0, max: 30,
    ticks: [0, 7, 14, 21, 28],
    color(v) {
      if (!(v > 0)) return null;
      const c = rampAt(seq, v / 30);
      return [c[0], c[1], c[2], 0.6];
    },
    css: seq,
  };
}

export function cssGradient(scale) {
  const stops = scale.diverging || scale.css.map((c) => `rgb(${c.join(',')})`);
  return `linear-gradient(to right, ${stops.join(',')})`;
}

/**
 * Regular grid helper. lats from -LAT_MAX..LAT_MAX, lons from -180..180-step.
 * get(i, j) returns the value at lat index i, lon index j (j wraps).
 */
export function makeGrid(step) {
  const nLat = Math.round((2 * LAT_MAX) / step) + 1;
  const nLon = Math.round(360 / step);
  return {
    step, nLat, nLon,
    lat: (i) => -LAT_MAX + i * step,
    lon: (j) => -180 + j * step,
  };
}

/**
 * Bilinear sample at lat/lon; NaN-aware. values[] is row-major nLat x nLon,
 * interleaved: the value of cell p is values[p * stride + off].
 */
export function sample(grid, values, lat, lon, stride = 1, off = 0) {
  const fi = (lat + LAT_MAX) / grid.step;
  let fj = (lon + 180) / grid.step;
  const i0 = Math.max(0, Math.min(grid.nLat - 2, Math.floor(fi)));
  const ti = Math.max(0, Math.min(1, fi - i0));
  const j0 = Math.floor(fj);
  const tj = fj - j0;
  const ja = ((j0 % grid.nLon) + grid.nLon) % grid.nLon;
  const jb = (ja + 1) % grid.nLon;
  const r0 = i0 * grid.nLon, r1 = r0 + grid.nLon;
  const v00 = values[(r0 + ja) * stride + off], v01 = values[(r0 + jb) * stride + off];
  const v10 = values[(r1 + ja) * stride + off], v11 = values[(r1 + jb) * stride + off];
  // Hot path (called per map pixel): no closures. v === v is false only for NaN.
  let s = 0, w = 0, ww;
  ww = (1 - ti) * (1 - tj); if (v00 === v00) { s += v00 * ww; w += ww; }
  ww = (1 - ti) * tj; if (v01 === v01) { s += v01 * ww; w += ww; }
  ww = ti * (1 - tj); if (v10 === v10) { s += v10 * ww; w += ww; }
  ww = ti * tj; if (v11 === v11) { s += v11 * ww; w += ww; }
  return w > 0.25 ? s / w : NaN;
}

/**
 * Draw one Web-Mercator map tile (Leaflet x/y/z) into `canvas`, which must
 * already be sized (canvas.width = tileSize * ratio). `field` = { grid,
 * values, stride, off }, sampled bilinearly. Discrete scales get a 1 px
 * darker outline on class boundaries; a 1 px margin around the tile keeps
 * the outline continuous across tile edges.
 */
export function drawTile(canvas, coords, tileSize, field, scale) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!field) return;
  const world = tileSize * 2 ** coords.z * (W / tileSize); // world size in canvas pixels
  const gx0 = coords.x * W, gy0 = coords.y * H;
  const latAt = (gy) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * gy) / world)) * 180) / Math.PI;
  // gx / world in [0, 1) maps to -180..180; wrapped world copies fold back in.
  const lonAt = (gx) => { let l = ((gx / world) * 360) % 360; if (l < 0) l += 360; return l - 180; };
  const { grid, values, stride, off } = field;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const M = W + 2; // class buffer with a 1 px margin on each side
  const cls = scale.discrete ? new Int16Array(M * (H + 2)) : null;
  const alpha255 = scale.discrete ? Math.round(scale.alpha * 255) : 0;
  const lons = new Float64Array(M);
  for (let x = -1; x <= W; x++) lons[x + 1] = lonAt(gx0 + x + 0.5);
  for (let y = -1; y <= H; y++) {
    const lat = latAt(gy0 + y + 0.5);
    const inside = y >= 0 && y < H;
    const ok = Math.abs(lat) <= LAT_MAX;
    for (let x = -1; x <= W; x++) {
      const v = ok ? sample(grid, values, lat, lons[x + 1], stride, off) : NaN;
      const o = (y * W + x) * 4;
      if (cls) {
        const k = scale.classOf(v);
        cls[(y + 1) * M + x + 1] = k;
        if (!inside || x < 0 || x >= W || k < 0) continue;
        const c = scale.classes[k].color;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = alpha255;
        continue;
      }
      if (!inside || x < 0 || x >= W) continue;
      const c = scale.color(v);
      if (!c) continue;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3] * 255;
    }
  }
  if (cls) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y + 1) * M + x + 1, k = cls[p];
        if (k < 0) continue;
        // Draw the line on the higher class only, so it stays 1 px wide.
        if (cls[p - 1] < k || cls[p + 1] < k || cls[p - M] < k || cls[p + M] < k) {
          const o = (y * W + x) * 4;
          d[o] *= 0.55; d[o + 1] *= 0.55; d[o + 2] *= 0.55; d[o + 3] = 235;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
