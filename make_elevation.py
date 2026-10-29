#!/usr/bin/env python3
"""
Ground height per level-14 cell (about 1 km), for the map's height filter.

    python3 make_elevation.py

Reads the terrarium elevation tiles the map's altitude shading uses, at zoom
8 (4 × 4 pixels a cell, about 250 m at 65°N), cached under cache/dem/. A cell
is land when at least half its pixels are, and gets the mean height of those;
the rest is sea. Written as data/wx/elev-<area>.bin.gz, a WXG1 file with one
band and one period, and listed under "elev" in data/wx/index.json. The area
is the grid layers' area at level 13, so run make_thunder_days.py first.
"""

import argparse, io, json, os, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

import wxgrid as wg

Z = 8                  # tile zoom; a tile pixel is a level Z+8 cell
L = 14                 # the stored level
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
CACHE = "cache/dem"
SEA = -32768


def tile(x, y):
    """Heights of one tile in metres, sea negative, from the cache or the web."""
    path = os.path.join(CACHE, str(Z), str(x), f"{y}.png")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(URL.format(z=Z, x=x, y=y), timeout=60) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--area", default="no")
    a = p.parse_args()
    with open(wg.INDEX) as f:
        idx = json.load(f)
    area = next(x for x in idx["areas"] if x["id"] == a.area)

    # The area at level 14, and the tile pixels under it.
    k = 2 ** (L - area["L"])
    x0, y0, nx, ny = area["x0"] * k, area["y0"] * k, area["nx"] * k, area["ny"] * k
    f = 2 ** (Z + 8 - L)
    px0, py0, pnx, pny = x0 * f, y0 * f, nx * f, ny * f
    tx = range(px0 // 256, (px0 + pnx - 1) // 256 + 1)
    ty = range(py0 // 256, (py0 + pny - 1) // 256 + 1)
    print(f"{a.area}: {nx} × {ny} cells at level {L}, {len(tx) * len(ty)} tiles at zoom {Z}")

    mosaic = np.empty((len(ty) * 256, len(tx) * 256), dtype=np.float32)
    jobs = [(i, j) for j in range(len(ty)) for i in range(len(tx))]
    with ThreadPoolExecutor(8) as pool:
        for (i, j), h in zip(jobs, pool.map(lambda ij: tile(tx[ij[0]], ty[ij[1]]), jobs)):
            mosaic[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = h
    ox, oy = px0 - tx[0] * 256, py0 - ty[0] * 256
    h = mosaic[oy:oy + pny, ox:ox + pnx].reshape(ny, f, nx, f)

    # Land is what the altitude shading draws: anything from −0.5 m up.
    land = h >= -0.5
    nland = land.sum(axis=(1, 3))
    mean = np.where(land, np.maximum(h, 0), 0).sum(axis=(1, 3)) / np.maximum(nland, 1)
    elev = np.where(nland * 2 >= f * f, np.rint(mean), SEA).astype(np.int16)
    print(f"  land cells {np.count_nonzero(elev != SEA):,}, highest {elev.max()} m")

    out = f"data/wx/elev-{a.area}.bin.gz"
    size = wg.write_wxg(out, L, x0, y0, nx, ny, 0,
                        [{"id": "elev", "dtype": 2, "scale": 1.0, "offset": 0.0,
                          "nodata": SEA & 0xFFFF, "data": elev[None]}], nperiods=1)
    print(f"  {out}  {size / 1e6:.1f} MB")

    # Kept at the top of the index, so the climate pipeline, which rewrites
    # its areas and layers, leaves it be.
    with open(wg.INDEX) as f:
        idx = json.load(f)
    idx["elev"] = dict(idx.get("elev", {}), **{a.area: out})
    with open(wg.INDEX, "w") as f:
        json.dump(idx, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
