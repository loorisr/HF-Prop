// Geography helpers: Maidenhead locators, great circles, day/night terminator.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function toLocator(lat, lon, chars = 6) {
  let x = lon + 180;
  let y = lat + 90;
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
  let s = A[Math.floor(x / 20)] + A[Math.floor(y / 10)];
  x %= 20; y %= 10;
  s += Math.floor(x / 2) + '' + Math.floor(y);
  if (chars >= 6) {
    x %= 2; y %= 1;
    s += A[Math.floor(x * 12)].toLowerCase() + A[Math.floor(y * 24)].toLowerCase();
  }
  return s;
}

/** Parse "JN18du" / "JN18" / "48.85, 2.35". Returns [lat, lon] or null. */
export function parsePosition(text) {
  const t = String(text || '').trim();
  const m = t.match(/^([A-Ra-r]{2})(\d\d)([A-Xa-x]{2})?(\d\d)?$/);
  if (m) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    let lon = A.indexOf(m[1][0].toUpperCase()) * 20 - 180 + Number(m[2][0]) * 2;
    let lat = A.indexOf(m[1][1].toUpperCase()) * 10 - 90 + Number(m[2][1]);
    let dlon = 2, dlat = 1;
    if (m[3]) {
      lon += A.indexOf(m[3][0].toUpperCase()) * (2 / 24);
      lat += A.indexOf(m[3][1].toUpperCase()) * (1 / 24);
      dlon = 2 / 24; dlat = 1 / 24;
      if (m[4]) {
        lon += Number(m[4][0]) * (dlon / 10);
        lat += Number(m[4][1]) * (dlat / 10);
        dlon /= 10; dlat /= 10;
      }
    }
    return [lat + dlat / 2, lon + dlon / 2];
  }
  const n = t.split(/[ ,;]+/).map(Number);
  if (n.length === 2 && n.every(Number.isFinite) && Math.abs(n[0]) <= 90 && Math.abs(n[1]) <= 180) return n;
  return null;
}

export function distanceKm(a, b) {
  const [la1, lo1, la2, lo2] = [a[0] * D2R, a[1] * D2R, b[0] * D2R, b[1] * D2R];
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 2 * 6371.009 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const [la1, lo1, la2, lo2] = [a[0] * D2R, a[1] * D2R, b[0] * D2R, b[1] * D2R];
  const y = Math.sin(lo2 - lo1) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Great-circle points, split into segments at the antimeridian for Leaflet. */
export function greatCircle(a, b, n = 128) {
  const [la1, lo1, la2, lo2] = [a[0] * D2R, a[1] * D2R, b[0] * D2R, b[1] * D2R];
  const d = distanceKm(a, b) / 6371.009;
  if (d < 1e-6) return [[a, b]];
  const segs = [[]];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    const lat = Math.atan2(z, Math.hypot(x, y)) * R2D;
    const lon = Math.atan2(y, x) * R2D;
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) segs.push([]);
    segs[segs.length - 1].push([lat, lon]);
    prevLon = lon;
  }
  return segs;
}

/** Subsolar point for the 15th of `month` (1-12) at `utcHour`. */
export function subsolar(month, utcHour, year = new Date().getUTCFullYear()) {
  const date = Date.UTC(year, month - 1, 15, utcHour, 30);
  const n = date / 86400000 - 10957.5; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = 23.439 * D2R;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda)) * R2D;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D;
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra - gmst;
  lon = ((lon + 540) % 360) - 180;
  return [decl, lon];
}

/** Polygon (lat/lon ring) covering the night side. */
export function nightPolygon(month, utcHour) {
  const [dec, slon] = subsolar(month, utcHour);
  const pts = [];
  const tanDec = Math.tan(dec * D2R);
  for (let lon = -180; lon <= 180; lon += 2) {
    const ha = (lon - slon) * D2R;
    const lat = Math.atan(-Math.cos(ha) / (Math.abs(tanDec) < 1e-6 ? 1e-6 : tanDec)) * R2D;
    pts.push([lat, lon]);
  }
  const pole = dec > 0 ? -90 : 90; // night pole
  pts.push([pole, 180], [pole, -180]);
  return pts;
}
