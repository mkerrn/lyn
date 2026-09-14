#!/usr/bin/env python3
"""
Split one big LYN1 file into one file per year, plus the index.json the map
reads to build its year list.

    python3 split_years.py 2016_to_2025.bin.gz --outdir data

Writes data/lightning-2016.bin.gz … data/lightning-2025.bin.gz and
data/index.json. The input is left alone; you don't need to commit it.

Optional thinning, applied to every year:

    --min-current 5     drop strikes weaker than 5 kA
    --cg-only           drop cloud-to-cloud
    --max-per-year N    even sample down to N strikes a year, in time order
"""

import argparse, datetime as dt, gzip, json, os, sys
from array import array

HEADER = 32
ITEM = 18   # 4+4+4+2+1+1+1+1


def read_lyn1(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rb") as f:
        blob = f.read()
    if blob[:4] != b"LYN1":
        raise SystemExit(f"{path} is not a LYN1 file")
    n = int.from_bytes(blob[4:8], "little")
    t0 = int.from_bytes(blob[8:12], "little")
    if len(blob) != HEADER + ITEM * n:
        raise SystemExit(f"{path}: expected {HEADER + ITEM*n} bytes, found {len(blob)}")

    def take(code, size, off):
        a = array(code)
        a.frombytes(blob[off:off + size * n])
        if sys.byteorder != "little" and size > 1:
            a.byteswap()
        return a

    o = HEADER
    t = take("I", 4, o); o += 4 * n
    lat = take("i", 4, o); o += 4 * n
    lon = take("i", 4, o); o += 4 * n
    peak = take("h", 2, o); o += 2 * n
    smaj = take("B", 1, o); o += n
    smin = take("B", 1, o); o += n
    ang = take("B", 1, o); o += n
    flags = take("B", 1, o)
    return n, t0, (t, lat, lon, peak, smaj, smin, ang, flags)


def write_lyn1(cols, idx, path, src_t0):
    t, lat, lon, peak, smaj, smin, ang, flags = cols
    n = len(idx)
    rel = t[idx[0]]              # relative to the input file's epoch
    t0 = src_t0 + rel            # the new file carries an absolute epoch
    out = [array("I"), array("i"), array("i"), array("h"),
           array("B"), array("B"), array("B"), array("B")]
    for i in idx:
        out[0].append(t[i] - rel)
        out[1].append(lat[i]); out[2].append(lon[i]); out[3].append(peak[i])
        out[4].append(smaj[i]); out[5].append(smin[i])
        out[6].append(ang[i]); out[7].append(flags[i])
    if sys.byteorder != "little":
        for a in out[:4]:
            a.byteswap()
    header = bytearray(32)
    header[0:4] = b"LYN1"
    header[4:8] = n.to_bytes(4, "little")
    header[8:12] = int(t0).to_bytes(4, "little")
    blob = bytes(header) + b"".join(a.tobytes() for a in out)
    if path.endswith(".gz"):
        with gzip.open(path, "wb", compresslevel=9) as f:
            f.write(blob)
    else:
        with open(path, "wb") as f:
            f.write(blob)
    return n, t0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input")
    p.add_argument("--outdir", default="data")
    p.add_argument("--min-current", type=float, default=0.0)
    p.add_argument("--cg-only", action="store_true")
    p.add_argument("--max-per-year", type=int, default=0)
    a = p.parse_args()

    n, t0, cols = read_lyn1(a.input)
    t, _, _, peak, _, _, _, flags = cols
    print(f"read {n:,} strikes from {a.input}")

    os.makedirs(a.outdir, exist_ok=True)
    by_year = {}
    for i in range(n):
        if a.cg_only and flags[i]:
            continue
        if abs(peak[i]) < a.min_current:
            continue
        y = dt.datetime.fromtimestamp(t0 + t[i], dt.timezone.utc).year
        by_year.setdefault(y, []).append(i)

    files = []
    for y in sorted(by_year):
        idx = by_year[y]
        kept = len(idx)
        if a.max_per_year and kept > a.max_per_year:
            step = kept / a.max_per_year
            idx = [idx[int(m * step)] for m in range(a.max_per_year)]
        name = f"lightning-{y}.bin.gz"
        path = os.path.join(a.outdir, name)
        cnt, first = write_lyn1(cols, idx, path, t0)
        size = os.path.getsize(path)
        last = t[idx[-1]] + t0
        files.append({
            "year": y, "file": f"{a.outdir}/{name}", "n": cnt, "bytes": size,
            "from": dt.datetime.fromtimestamp(first, dt.timezone.utc).date().isoformat(),
            "to": dt.datetime.fromtimestamp(last, dt.timezone.utc).date().isoformat(),
        })
        note = f" (sampled from {kept:,})" if a.max_per_year and kept > a.max_per_year else ""
        print(f"  {y}  {cnt:>9,} strikes{note}  {size/1e6:>6.1f} MB")

    with open(os.path.join(a.outdir, "index.json"), "w") as f:
        json.dump({"format": "LYN1", "files": files}, f, indent=1)
    total = sum(f["bytes"] for f in files)
    print(f"wrote {len(files)} files and index.json, {total/1e6:.0f} MB total")


if __name__ == "__main__":
    main()
