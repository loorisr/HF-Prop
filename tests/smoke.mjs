import { readFile } from 'node:fs/promises';
import { createEngine, ANT, NOISE } from '../web/js/engine.js';
const root = new URL('../web/', import.meta.url);
const eng = await createEngine({ fetchBytes: async (p) => new Uint8Array(await readFile(new URL(p, root))), log: console.log });
let t = performance.now();
await eng.loadMonth(1);
console.log('loadMonth ms', (performance.now() - t).toFixed(0));
const bands = [1.85, 3.6, 5.36, 7.1, 10.12, 14.1, 18.1, 21.1, 24.93, 28.3];
eng.setAntennaFreqs(bands);
eng.setParams({ ssn: 120, powerW: 100, bw: 3000, snrReq: 10, noise: NOISE.residential, year: 2025 });
eng.setAntenna(0, { type: ANT.iso }, bands.length); eng.setAntenna(1, { type: ANT.iso }, bands.length);
// Atlanta -> London, 17 UTC Jan
for (const f of bands) { const r = eng.run(33.749, -84.388, 51.5074, -0.1278, 17, f); console.log(f, r && [r.opmuf.toFixed(1), r.snr.toFixed(1), r.rel.toFixed(0), r.dist.toFixed(0), r.ele.toFixed(1)].join(' ')); }
t = performance.now(); let n=0;
for (let h=0;h<24;h++) for (const f of bands) { eng.run(48.85, 2.35, 40.7, -74.0, h, f); n++; }
console.log('per call ms', ((performance.now()-t)/n).toFixed(3));
t = performance.now(); n=0;
for (let lat=-80; lat<=80; lat+=10) for (let lon=-180; lon<180; lon+=10) { eng.run(48.85, 2.35, lat, lon, 12, 14.1); n++; }
console.log('grid per call ms', ((performance.now()-t)/n).toFixed(3), n);
// dipole
eng.setAntenna(0, { type: ANT.dipole, height: 10 }, bands.length); eng.setAntenna(1, { type: ANT.dipole, height: 10 }, bands.length);
for (const f of bands) { const r = eng.run(48.85, 2.35, 40.7, -74.0, 15, f); console.log('dipole', f, r && [r.opmuf.toFixed(1), r.snr.toFixed(1), r.rel.toFixed(0), r.ele.toFixed(1)].join(' ')); }
