// Web Worker: owns one P.533 engine instance and runs batches of paths.
import { createEngine } from './engine.js';

const ROOT = new URL('../', self.location.href);
const CACHE = 'hfprop-data-v1';

async function fetchBytes(path) {
  const url = new URL(path, ROOT).href;
  let res = null;
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    res = await cache.match(url);
  } catch { /* Cache API unavailable (e.g. file://) */ }
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    if (cache && !path.endsWith('.wasm')) {
      try { await cache.put(url, res.clone()); } catch { /* quota */ }
    }
  }
  return new Uint8Array(await res.arrayBuffer());
}

let enginePromise = null;
let cfgKey = '';

async function configure(cfg) {
  const eng = await (enginePromise ||= createEngine({ fetchBytes }));
  const key = JSON.stringify(cfg);
  if (key === cfgKey) return eng;
  await eng.loadMonth(cfg.month);
  eng.setAntennaFreqs(cfg.antFreqs);
  eng.setParams(cfg.params);
  eng.setAntenna(0, cfg.antTx, cfg.antFreqs.length);
  eng.setAntenna(1, cfg.antRx, cfg.antFreqs.length);
  cfgKey = key;
  return eng;
}

self.onmessage = async (ev) => {
  const { id, task } = ev.data;
  try {
    const eng = await configure(task.cfg);
    if (task.type === 'warm') {
      self.postMessage({ id, ok: true, data: null });
    } else if (task.type === 'p2p') {
      // All hours x all freqs for one path.
      const { tx, rx, freqs } = task;
      const out = [];
      for (let h = 0; h < 24; h++) {
        const row = [];
        for (const f of freqs) row.push(eng.run(tx[0], tx[1], rx[0], rx[1], h, f));
        out.push(row);
      }
      self.postMessage({ id, ok: true, data: out });
    } else if (task.type === 'grid') {
      // points: Float64Array [lat0, lon0, lat1, lon1, ...]; result [n * nf * 4] = muf50, muf90, snr, rel
      const { tx, hour, freqs, points } = task;
      const n = points.length / 2;
      const nf = freqs.length;
      const out = new Float32Array(n * nf * 4);
      const tmp = new Float64Array(4);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < nf; k++) {
          eng.runInto(tmp, 0, tx[0], tx[1], points[2 * i], points[2 * i + 1], hour, freqs[k]);
          out.set(tmp, (i * nf + k) * 4);
        }
      }
      self.postMessage({ id, ok: true, data: out }, [out.buffer]);
    } else if (task.type === 'antenna') {
      const { which, freq } = task;
      const out = [];
      for (let el = 0; el <= 90; el++) out.push(eng.antGain(which, el, 0, freq));
      self.postMessage({ id, ok: true, data: out });
    } else {
      throw new Error('unknown task ' + task.type);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
