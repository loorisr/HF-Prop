# HF Prop — ITU-R P.533 HF propagation, 100 % in the browser

A static web app (no server, no backend) that runs the official
**ITU-R P.533-14** HF propagation method (ITU-R Study Group 3 reference code,
ITURHFProp v14.3) compiled to WebAssembly.

- **Path** tab: set your station (TX) and a receiver (RX) on the map, by Maidenhead
  locator or by lat/lon. You get, per band (160 m → 10 m): reliability, SNR, margin
  over the mode's required SNR, a 24 h × band heatmap, and the MUF / FOT curve.
- **Coverage map** tab: world maps from your station of the **best frequency (FOT)**,
  the **MUF**, or the **reliability / SNR on one band**. Progressive rendering:
  a 12° grid appears almost instantly, then it is refined to 6°, 3° and 1.5°.
- Settings: month, UTC hour, sunspot number (automatic from NOAA SWPC, or manual),
  power, mode (SSB, CW, FT8, FT4, WSPR, AM), TX/RX antenna (isotropic, ¼λ vertical,
  ½λ dipole, 3-element Yagi + height), receiver noise environment.
- The state is kept in the URL, so a prediction can be shared as a link.

## Deploy on GitHub Pages

1. Create a repository and push this folder to its `main` branch.
2. *Settings → Pages → Build and deployment → Source: **GitHub Actions***.
3. The `Deploy to GitHub Pages` workflow publishes the `web/` folder. That's all:
   the WebAssembly engine and the data are already in the repository.

Local test: `cd web && python3 -m http.server 8000`, then open http://localhost:8000
(a web server is needed: module workers and `fetch` don't work from `file://`).

## Where the data lives

| What | Where | Size |
|---|---|---|
| Ionospheric maps foF2 / M(3000)F2 (1 file per month) | `web/data/ionMM.pk.gz`, in the repo | ≈3.5 MB/month, 42 MB total |
| Noise coefficients (1 per month), P.1239 decile table | `web/data/*.txt.gz`, in the repo | ≈70 kB each |
| Sunspot number | NOAA SWPC JSON API, fetched when the page opens (cached 12 h) | a few kB |

The ITU coefficients never change, so they are in the repository: no third-party
dependency, and a browser only downloads the month it needs, once (Cache Storage).
Only the solar index, which does change, comes from an API. If NOAA is unreachable,
you can enter the SSN by hand.

The ionospheric files are re-packed by `scripts/pack_data.py` (uint16 quantisation
— 0.33 kHz on foF2 — delta coding + byte planes): 3.5 MB instead of 9.4 MB gzipped
per month, with no measurable effect on the results.

## Why it is fast

OpenHamClock's WASM port runs ITURHFProp's `main()`: every call re-reads 11 MB of
coefficients, parses a text config and writes a text report. Here:

- `engine/ohp.c` is a small driver that **loads the month once**, then calls `P533()`
  directly: ≈0.1 ms per path (short) to 0.35 ms (long) in WebAssembly.
- A **pool of Web Workers** (one engine each, ≈45 MB) splits the map grid.
- **Coarse to fine progressive grid** with reuse of points already computed, and
  bilinear interpolation for display.
- MUF / FOT maps need only **one** run per point (the MUF doesn't depend on the frequency).
- "Follow" antennas (always pointed at the other station) are stored as a single
  elevation profile: no pattern recomputation per point.

## Model and limits

- Monthly median predictions (statistical): magnetic storms, sporadic-E, aurora
  and day-to-day variability are not modelled.
- P.533 is fairly **conservative**: in SSB (10 dB in 3 kHz) many paths come out
  "Poor"; in FT8 the same path will often be open.
- Antennas: analytic patterns over average ground (εr = 13, σ = 5 mS/m), not NEC
  models. Good enough for comparisons, not to dimension an antenna.
- MUF = median MUF (50 % of days); FOT = MUF exceeded on 90 % of days.

## Rebuild the engine (optional)

```bash
sudo apt install clang lld wasi-libc libclang-rt-18-dev-wasm32
engine/build.sh          # → web/engine/p533.wasm
node tests/smoke.mjs     # quick check
```

Data (if you want to regenerate it): clone
https://github.com/ITU-R-Study-Group-3/ITU-R-HF (tag v14.3) and run
`python3 scripts/pack_data.py ITU-R-HF/ITURHFProp/Data web/data`.

## Credits & licences

- **ITU-R P.533 / P.372 engine and data**: ITU-R Study Group 3 (Behm, Engelbrecht,
  Watson…). *"It may be used by implementers in their implementation of the
  Recommendation … free from any copyright assertions"*, provided AS IS. Sources in
  `engine/vendor/` (unmodified, apart from the static build via `engine/ohp_shim.h`).
- Idea of the WASM port: [OpenHamClock](https://github.com/accius/openhamclock) (MIT).
- [Leaflet](https://leafletjs.com) (BSD-2), [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) (MIT/Apache-2.0).
- Basemap © OpenStreetMap contributors. Solar data: NOAA SWPC.
