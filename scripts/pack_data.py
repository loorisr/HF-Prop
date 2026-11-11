#!/usr/bin/env python3
"""
Pack the ITU-R P.533 coefficient files for the static website.

Usage:  python3 scripts/pack_data.py <ITU-R-HF checkout>/ITURHFProp/Data web/data

ionosMM.bin (11.2 MB of float32) is quantised to uint16 (foF2 x3000 -> 0.33 kHz
steps, M(3000)F2 x15000), delta-coded along the hour axis and split into byte
planes, then gzipped: ~3.6 MB per month instead of ~9.4 MB for the gzipped
original. The decoder is ohp_load_month() in engine/ohp.c.

COEFFMMW.txt (noise) and "P1239-3 Decile Factors.txt" are just gzipped.
Browsers decompress with DecompressionStream('gzip').
"""
import gzip
import sys
from pathlib import Path

import numpy as np

N = 24 * 241 * 121 * 2


def pack_ionos(src: Path) -> bytes:
    b = src.read_bytes()
    assert len(b) == 5 + 8 * N + 10 + 5, f"unexpected size {len(b)}"
    fof2 = np.frombuffer(b[5:5 + 4 * N], dtype="<f4")
    m3k = np.frombuffer(b[5 + 4 * N + 10:5 + 8 * N + 10], dtype="<f4")
    out = []
    for arr, scale in ((fof2, 3000.0), (m3k, 15000.0)):
        q = np.round(arr.astype(np.float64) * scale)
        assert q.min() >= 0 and q.max() < 65536, (q.min(), q.max())
        q = q.astype(np.int64).reshape(-1, 24)
        d = (np.diff(q, axis=1, prepend=0) % 65536).astype("<u2").ravel()
        planes = d.view(np.uint8).reshape(-1, 2)
        out.append(planes[:, 0].tobytes() + planes[:, 1].tobytes())
        # self-check: decode and compare
        dec = (np.cumsum(d.reshape(-1, 24).astype(np.int64), axis=1) % 65536) / scale
        err = np.abs(dec.ravel() - arr).max()
        assert err < 1.0 / scale, err
    return b"".join(out)


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    for m in range(1, 13):
        raw = pack_ionos(src / f"ionos{m:02d}.bin")
        (dst / f"ion{m:02d}.pk.gz").write_bytes(gzip.compress(raw, 9, mtime=0))
        coeff = (src / f"COEFF{m:02d}W.txt").read_bytes()
        (dst / f"COEFF{m:02d}W.txt.gz").write_bytes(gzip.compress(coeff, 9, mtime=0))
        print(f"month {m:02d} ok")
    dec = (src / "P1239-3 Decile Factors.txt").read_bytes()
    (dst / "P1239-3.txt.gz").write_bytes(gzip.compress(dec, 9, mtime=0))


if __name__ == "__main__":
    main()
