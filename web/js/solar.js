// Smoothed sunspot number from NOAA SWPC (CORS-enabled public JSON).
// predicted-solar-cycle.json gives monthly predicted smoothed SSN; the
// observed file gives the last measured smoothed value. Cached 12 h.

const PRED = 'https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json';
const OBS = 'https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json';
const KEY = 'hfprop-ssn-v1';

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function num(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

async function loadTables() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && Date.now() - c.t < 12 * 3600e3) return c;
  } catch { /* ignore */ }
  const [pred, obs] = await Promise.allSettled([getJson(PRED), getJson(OBS)]);
  const table = {};
  let lastObs = null;
  if (obs.status === 'fulfilled' && Array.isArray(obs.value)) {
    for (const e of obs.value) {
      const tag = String(e['time-tag'] || e.time_tag || '').slice(0, 7);
      const s = num(e.smoothed_ssn);
      if (tag && s !== null) { table[tag] = { ssn: s, src: 'observed' }; lastObs = tag; }
    }
  }
  if (pred.status === 'fulfilled' && Array.isArray(pred.value)) {
    for (const e of pred.value) {
      const tag = String(e['time-tag'] || e.time_tag || '').slice(0, 7);
      const s = num(e.predicted_ssn, e.predicted_ssn_smoothed);
      if (tag && s !== null && !table[tag]) table[tag] = { ssn: s, src: 'predicted' };
    }
  }
  if (!Object.keys(table).length) throw new Error('NOAA data unavailable');
  const c = { t: Date.now(), table, lastObs };
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ }
  return c;
}

/** Returns { ssn, src, tag } for year/month, or throws. */
export async function ssnFor(year, month) {
  const { table } = await loadTables();
  const tag = `${year}-${String(month).padStart(2, '0')}`;
  if (table[tag]) return { ...table[tag], tag };
  // Nearest available month.
  const tags = Object.keys(table).sort();
  let best = tags[0];
  for (const t of tags) if (t <= tag) best = t;
  return { ...table[best], tag: best };
}
