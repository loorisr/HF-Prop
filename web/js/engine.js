// P.533 engine wrapper: loads p533.wasm (WASI reactor) and the coefficient
// data, and exposes a small synchronous API. Works in a Web Worker, on the
// main thread and in Node (tests) — the caller supplies `fetchBytes`.

import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } from '../vendor/wasi/index.js';

export const ANT = { iso: 0, vertical: 1, dipole: 2, yagi: 3 };
export const NOISE = { city: 0, residential: 1, rural: 2, quiet: 3 };

const R = {
  BMUF: 0, MUF50: 1, MUF90: 2, MUF10: 3, OPMUF: 4, OPMUF90: 5, OPMUF10: 6,
  Pr: 7, SNR: 8, BCR: 9, dist: 10, Ep: 11, hopsF2: 12, hopsE: 13, DuSN: 14, DlSN: 15, ele: 16, SNR90: 17,
};

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * @param {object} o
 * @param {(path:string)=>Promise<Uint8Array>} o.fetchBytes  fetch a file relative to the site root
 * @param {(msg:string)=>void} [o.log]
 */
export async function createEngine({ fetchBytes, log = () => {} }) {
  const dataDir = new PreopenDirectory('/data', []);
  const fds = [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((m) => log('[p533] ' + m)),
    ConsoleStdout.lineBuffered((m) => log('[p533 err] ' + m)),
    dataDir,
  ];
  const wasi = new WASI([], [], fds, { debug: false });
  const [wasmBytes, p1239] = await Promise.all([
    fetchBytes('engine/p533.wasm'),
    fetchBytes('data/P1239-3.txt.gz').then(gunzip),
  ]);
  const { instance } = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: wasi.wasiImport });
  wasi.initialize(instance);
  const X = instance.exports;

  dataDir.dir.contents.set('P1239-3 Decile Factors.txt', new File(p1239));
  let rc = X.ohp_init();
  if (rc !== 0) throw new Error('ohp_init failed: ' + rc);

  const resPtr = X.ohp_result_ptr();
  let month = 0;

  async function loadMonth(m) {
    if (m === month) return;
    const mm = String(m).padStart(2, '0');
    const [ion, coeff] = await Promise.all([
      fetchBytes(`data/ion${mm}.pk.gz`).then(gunzip),
      fetchBytes(`data/COEFF${mm}W.txt.gz`).then(gunzip),
    ]);
    dataDir.dir.contents.set(`COEFF${mm}W.txt`, new File(coeff));
    const ptr = X.ohp_ion_buffer();
    new Uint8Array(X.memory.buffer, ptr, ion.length).set(ion);
    const r = X.ohp_load_month(m);
    if (r !== 0) throw new Error('ohp_load_month failed: ' + r);
    dataDir.dir.contents.delete(`COEFF${mm}W.txt`);
    month = m;
  }

  function setParams({ ssn, powerW, bw, snrReq, noise, year }) {
    X.ohp_set_params(Math.round(ssn), powerW, bw, snrReq, noise, year);
  }

  function setAntennaFreqs(freqs) {
    freqs.forEach((f, i) => X.ohp_set_ant_freq(i, f));
  }

  /** which: 0 TX, 1 RX. heading < 0 → always aimed at the other station. */
  function setAntenna(which, { type, height = 10, heading = -1, extra = 0 }, nfreq) {
    X.ohp_set_antenna(which, type, height, heading, extra, nfreq || 0);
  }

  /** One P.533 run. Returns null if the engine rejected the inputs. */
  function run(txLat, txLon, rxLat, rxLon, utcHour, freq) {
    const st = X.ohp_run(txLat, txLon, rxLat, rxLon, utcHour, freq);
    if (st !== 10) return null;
    const r = new Float64Array(X.memory.buffer, resPtr, 18);
    return {
      freq,
      bmuf: r[R.BMUF], muf50: r[R.MUF50], muf90: r[R.MUF90], muf10: r[R.MUF10],
      opmuf: r[R.OPMUF], opmuf90: r[R.OPMUF90], opmuf10: r[R.OPMUF10],
      pr: r[R.Pr], snr: r[R.SNR], snr90: r[R.SNR90], rel: r[R.BCR], dist: r[R.dist],
      ep: r[R.Ep], hopsF2: r[R.hopsF2], hopsE: r[R.hopsE], ele: r[R.ele],
    };
  }

  /** Lightweight variant for maps: writes [muf50, muf90, snr, rel] into out at offset. */
  function runInto(out, off, txLat, txLon, rxLat, rxLon, utcHour, freq) {
    const st = X.ohp_run(txLat, txLon, rxLat, rxLon, utcHour, freq);
    const r = new Float64Array(X.memory.buffer, resPtr, 18);
    if (st !== 10) { out[off] = out[off + 1] = out[off + 2] = out[off + 3] = NaN; return; }
    out[off] = r[R.MUF50]; out[off + 1] = r[R.MUF90]; out[off + 2] = r[R.SNR]; out[off + 3] = r[R.BCR];
  }

  const antGain = (which, el, az, f) => X.ohp_ant_gain(which, el, az, f);
  const memoryBytes = () => X.memory.buffer.byteLength;
  return { antGain, memoryBytes, loadMonth, setParams, setAntennaFreqs, setAntenna, run, runInto };
}
