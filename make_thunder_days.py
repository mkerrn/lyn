#!/usr/bin/env python3
"""
Thunderstorm days on the level-13 cell grid, from the per-year lightning files.

    python3 make_thunder_days.py

A cell has a thunderstorm day when any strike, cloud-to-ground or
cloud-to-cloud, falls within 10 km of its centre during that local solar day
(UTC + longitude/15 h, taken at the strike). The counts are summed per
half-month and written as data/wx/thunder-no-<year>.bin.gz, one per year, and
thunder-no-mean.bin.gz with the mean over all of them, and the layer is added
to data/wx/index.json. The area is the bounding box of the lightning, sea
included: this is the one grid layer without a land mask.
"""

import argparse, glob, os, time

import numpy as np

from split_years import read_lyn1
import wxgrid as wg

L = 13
RADIUS_KM = 10.0
KM_PER_DEG = 111.195
FINE = 16          # strikes closer than a level-16 cell (~250 m) on one day count once

LAYER = {
    "id": "thunder", "label": "Thunderstorm days", "source": "MET Norway lightning",
    "attribution": "Lightning © MET Norway",
    "note": "A day counts when the Nordic lightning network placed any strike, cloud to ground "
            "or cloud to cloud, within 10 km of the cell centre, in local solar time. "
            "Detection falls off far offshore, so the open sea reads lower than it should.",
    "bands": [{"id": "days", "label": "Thunderstorm days", "unit": "days", "agg": "sum", "ramp": "seq"}],
}


def load(paths):
    lat, lon, t = [], [], []
    for p in sorted(paths):
        n, t0, cols = read_lyn1(p)
        t.append(np.frombuffer(cols[0], dtype=np.uint32).astype(np.int64) + t0)
        lat.append(np.frombuffer(cols[1], dtype=np.int32) / 1e5)
        lon.append(np.frombuffer(cols[2], dtype=np.int32) / 1e5)
        print(f"  {os.path.basename(p)}  {n:>9,} strikes")
    return np.concatenate(lat), np.concatenate(lon), np.concatenate(t)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data", help="folder with lightning-*.bin.gz")
    p.add_argument("--area", default="no")
    a = p.parse_args()
    t_start = time.time()

    lat, lon, t = load(glob.glob(os.path.join(a.data, "lightning-*.bin.gz")))
    days = wg.solar_days(t, lon)

    # The area: the box round every strike, plus the 10 km reach.
    x0, y0, nx, ny = wg.area_of_bbox(lon.min(), lat.min(), lon.max(), lat.max(), L, pad_cells=8)
    ncell = nx * ny
    rlat, clon = wg.cell_centres(L, x0, y0, nx, ny)
    print(f"area {a.area}: level {L}, x0 {x0}, y0 {y0}, {nx} × {ny} cells")

    # One point per strike cluster and day: many strikes of one storm land in
    # the same few hundred metres, and they all mark the same cells.
    wx, wy = wg.world_xy(lat, lon)
    fx = np.floor(wx * 2 ** FINE).astype(np.int64)
    fy = np.floor(wy * 2 ** FINE).astype(np.int64)
    key = np.unique((days << 32) | (fx << 16) | fy)
    days, fx, fy = key >> 32, (key >> 16) & 0xFFFF, key & 0xFFFF
    plat = wg.lat_of_world_y((fy + 0.5) / 2 ** FINE)
    plon = (fx + 0.5) / 2 ** FINE * 360 - 180
    cx = (fx >> (FINE - L)) - x0
    cy = (fy >> (FINE - L)) - y0
    print(f"{len(key):,} strike clusters after merging within a day")

    # How many cells the 10 km reaches at the northern edge, where they are smallest.
    side = 40075.016686 * np.cos(np.radians(rlat.min())) / 2 ** L
    R = int(np.ceil(RADIUS_KM / side)) + 1

    years, _, _, _ = wg.day_parts(days)
    out = {}
    for y in wg.YEARS:
        sel = years == y
        d, px, py, la, lo = days[sel], cx[sel], cy[sel], plat[sel], plon[sel]
        day0 = int(np.datetime64(f"{y}-01-01").astype(np.int64))
        hits = []
        for oy in range(-R, R + 1):
            ty = py + oy
            okY = (ty >= 0) & (ty < ny)
            for ox in range(-R, R + 1):
                tx = px + ox
                ok = okY & (tx >= 0) & (tx < nx)
                tyo, txo = ty[ok], tx[ok]
                clat = rlat[tyo]
                dy = (clat - la[ok]) * KM_PER_DEG
                dx = (clon[txo] - lo[ok]) * KM_PER_DEG * np.cos(np.radians((clat + la[ok]) / 2))
                near = dx * dx + dy * dy <= RADIUS_KM ** 2
                hits.append((d[ok][near] - day0) * ncell + tyo[near] * nx + txo[near])
        hits = np.unique(np.concatenate(hits)) if hits else np.zeros(0, np.int64)
        _, _, _, per = wg.day_parts(hits // ncell + day0)
        counts = np.bincount(per * ncell + hits % ncell, minlength=wg.NPERIODS * ncell)
        out[y] = counts.reshape(wg.NPERIODS, ny, nx).astype(np.uint8)
        print(f"  {y}: {sel.sum():>8,} clusters, {len(hits):>10,} cell-days, "
              f"busiest cell {out[y].sum(axis=0).max()} days")

    band = {"id": "days", "dtype": 1, "scale": 1.0, "offset": 0.0, "nodata": 255}
    files, total = {}, 0
    for y, c in out.items():
        path = f"data/wx/thunder-{a.area}-{y}.bin.gz"
        total += wg.write_wxg(path, L, x0, y0, nx, ny, y, [dict(band, data=c)])
        files[str(y)] = path

    # The mean over the years, in tenths of a day: exact for ten years.
    mean = np.mean([c.astype(np.float32) for c in out.values()], axis=0)
    path = f"data/wx/thunder-{a.area}-mean.bin.gz"
    total += wg.write_wxg(path, L, x0, y0, nx, ny, 0,
                          [dict(band, scale=0.1, data=np.round(mean * 10).astype(np.uint8))])
    files["0"] = path

    area = {"id": a.area, "L": L, "x0": x0, "y0": y0, "nx": nx, "ny": ny}
    wg.update_index(area, LAYER, files)
    print(f"wrote {len(files)} files, {total/1e6:.1f} MB, and {wg.INDEX} in {time.time()-t_start:.0f} s")


if __name__ == "__main__":
    main()
