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

/**
 * Color scale for a map kind. `dark` flips the sequential ramp so that
 * "more" is always the higher-contrast end against the basemap.
 * Returns { color(v) -> [r,g,b,a] | null, min, max, unit, ticks, label }.
 */
export function scaleFor(kind, { dark, snrReq = 0 }) {
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

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;

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

/** Bilinear sample of values[] (row-major nLat x nLon) at lat/lon; NaN-aware. */
export function sample(grid, values, lat, lon) {
  const fi = (lat + LAT_MAX) / grid.step;
  let fj = (lon + 180) / grid.step;
  const i0 = Math.max(0, Math.min(grid.nLat - 2, Math.floor(fi)));
  const ti = Math.max(0, Math.min(1, fi - i0));
  const j0 = Math.floor(fj);
  const tj = fj - j0;
  const ja = ((j0 % grid.nLon) + grid.nLon) % grid.nLon;
  const jb = (ja + 1) % grid.nLon;
  const v00 = values[i0 * grid.nLon + ja], v01 = values[i0 * grid.nLon + jb];
  const v10 = values[(i0 + 1) * grid.nLon + ja], v11 = values[(i0 + 1) * grid.nLon + jb];
  let s = 0, w = 0;
  const add = (v, ww) => { if (Number.isFinite(v)) { s += v * ww; w += ww; } };
  add(v00, (1 - ti) * (1 - tj)); add(v01, (1 - ti) * tj); add(v10, ti * (1 - tj)); add(v11, ti * tj);
  return w > 0.25 ? s / w : NaN;
}

/** Render values to a canvas in Web-Mercator, bounds [-LAT_MAX, LAT_MAX] x [-180, 180]. */
export function renderOverlay(grid, values, scale, width = 1024) {
  const y0 = mercY(-LAT_MAX), y1 = mercY(LAT_MAX);
  const height = Math.round((width * (y1 - y0)) / (2 * Math.PI));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let py = 0; py < height; py++) {
    const lat = invMercY(y1 - ((py + 0.5) / height) * (y1 - y0));
    for (let px = 0; px < width; px++) {
      const lon = -180 + ((px + 0.5) / width) * 360;
      const v = sample(grid, values, lat, lon);
      const c = scale.color(v);
      if (!c) continue;
      const o = (py * width + px) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3] * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
