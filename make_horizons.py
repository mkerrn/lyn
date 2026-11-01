#!/usr/bin/env python3
"""
Terrain horizons for the "Sun seen from the ground" layer.

    python3 make_horizons.py

Every land cell of the climate pipeline gets 16 sample points, one jittered
point in each square of a 4 × 4 split, and each point the angle of the
horizon at 64 azimuths. The horizon marches out to 40 km over the terrarium
tiles at zoom 10 (about 65 m at 65°N, cached under cache/dem/10/), in steps
that grow with distance, and drops the far terrain for the earth's curvature
less refraction: d² / 2R × 0.87. The eye is 2 m above the ground. Points
that fall in the sea are marked, so a coastal cell counts its land only.

Writes cache/horizons/<area>.npz: "hz" (cells × 16 × 64, uint8, angle =
raw × 0.3 − 6 degrees, azimuth k × 360/64 from north, clockwise) and "land"
(cells × 16). The cells are those of cache/wx/<area>/cells.npz, in its
order, so run fetch_climate.py once first (it makes that file in a minute).
Takes about 10 minutes and 3 GB of memory.
"""

import argparse, json, os, time

import numpy as np
from numba import njit, prange

import make_elevation as me
import wxgrid as wg

Z = 10                 # tile zoom; a tile pixel is a level Z+8 cell
NPTS = 4               # points a side per cell
NAZ = 64
REACH = 40000.0        # m
EYE = 2.0              # m
R = 6371000.0
SEA = -100             # heights below this are sea; skipped tiles are filled with it
HZ_SCALE, HZ_OFFSET = 0.3, -6.0


@njit(parallel=True, cache=True)
def horizons(dem, px, py, mpp, out):
    """out[p, k] = encoded horizon angle at azimuth k of point p, at pixel
    (px, py) of the mosaic, mpp metres a pixel there."""
    ny, nx = dem.shape
    for p in prange(len(px)):
        x0, y0, m = px[p], py[p], mpp[p]
        h0 = dem[int(y0), int(x0)] + EYE
        for k in range(NAZ):
            a = 2 * np.pi * k / NAZ
            dx, dy = np.sin(a) / m, -np.cos(a) / m       # pixels a metre; y runs south
            best = -1.0
            d = m
            while d <= REACH:
                xi, yi = int(x0 + dx * d), int(y0 + dy * d)
                if xi < 0 or yi < 0 or xi >= nx or yi >= ny:
                    break
                t = (dem[yi, xi] - h0 - d * d / (2 * R) * 0.87) / d
                if t > best:
                    best = t
                d += max(m, 0.02 * d)
            deg = np.degrees(np.arctan(best))
            out[p, k] = min(max(round((deg - HZ_OFFSET) / HZ_SCALE), 0), 254)


def point_horizons(lat, lon):
    """Horizon angles in degrees (points × 64) at single places, such as
    stations, from a mosaic of the tiles round each."""
    me.Z = Z
    out = np.empty((len(lat), NAZ), np.float32)
    for n, (la, lo) in enumerate(zip(lat, lon)):
        X, Y = wg.world_xy(la, lo)
        X, Y = X * 2 ** (Z + 8), Y * 2 ** (Z + 8)
        mpp = 40075016.7 * np.cos(np.radians(la)) / 2 ** (Z + 8)
        k = int(np.ceil(REACH / mpp / 256)) + 1
        tx0, ty0 = int(X // 256) - k, int(Y // 256) - k
        dem = np.vstack([np.hstack([me.tile(tx0 + i, ty0 + j) for i in range(2 * k + 1)])
                         for j in range(2 * k + 1)]).astype(np.float32)
        hz = np.empty((1, NAZ), np.uint8)
        horizons(dem, np.array([X - tx0 * 256]), np.array([Y - ty0 * 256]), np.array([mpp]), hz)
        out[n] = hz[0] * HZ_SCALE + HZ_OFFSET
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--area", default="no")
    a = p.parse_args()
    with open(wg.INDEX) as f:
        area = next(x for x in json.load(f)["areas"] if x["id"] == a.area)
    cells = np.load(f"cache/wx/{a.area}/cells.npz")
    cell = cells["cell"]
    L = area["L"]
    f = 2 ** (Z + 8 - L)                                  # pixels a cell side

    # The mosaic: the area plus the reach, in pixels at zoom Z, which are
    # smallest at the north edge.
    north = wg.lat_of_world_y(area["y0"] / 2 ** L)
    pad = int(np.ceil(REACH / (40075016.7 * np.cos(np.radians(north)) / 2 ** (Z + 8))))
    px0, py0 = area["x0"] * f - pad, area["y0"] * f - pad
    pnx, pny = area["nx"] * f + 2 * pad, area["ny"] * f + 2 * pad
    tx = np.arange(px0 // 256, (px0 + pnx - 1) // 256 + 1)
    ty = np.arange(py0 // 256, (py0 + pny - 1) // 256 + 1)

    # Only tiles within reach of a land cell are needed.
    land = np.zeros(area["ny"] * area["nx"], bool)
    land[cell] = True
    land = land.reshape(area["ny"], area["nx"])
    reach = int(np.ceil(pad / f)) + 1
    rows, cols = np.nonzero(land)
    need = np.zeros((len(ty), len(tx)), bool)
    for r, c in zip(rows, cols):
        X, Y = (area["x0"] + c) * f, (area["y0"] + r) * f
        i0, i1 = (X - reach * f) // 256 - tx[0], (X + (reach + 1) * f) // 256 - tx[0]
        j0, j1 = (Y - reach * f) // 256 - ty[0], (Y + (reach + 1) * f) // 256 - ty[0]
        need[max(j0, 0):j1 + 1, max(i0, 0):i1 + 1] = True
    print(f"{a.area}: {len(cell):,} land cells, {need.sum():,} of {need.size:,} tiles at zoom {Z}", flush=True)

    me.Z = Z
    mosaic = np.full((len(ty) * 256, len(tx) * 256), SEA - 1, np.float32)
    jobs = list(zip(*np.nonzero(need)))
    t0 = time.time()
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(16) as pool:
        for k, ((j, i), h) in enumerate(zip(jobs, pool.map(lambda ji: me.tile(tx[ji[1]], ty[ji[0]]), jobs))):
            mosaic[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = h
            if (k + 1) % 1000 == 0:
                print(f"  {k + 1:,} tiles, {time.time() - t0:.0f} s", flush=True)
    ox, oy = px0 - tx[0] * 256, py0 - ty[0] * 256
    dem = np.ascontiguousarray(mosaic[oy:oy + pny, ox:ox + pnx])
    del mosaic

    # The sample points, fixed by a seeded generator so a rerun gives the same.
    rng = np.random.default_rng(13)
    r, c = np.divmod(cell, area["nx"])
    sub = (np.arange(NPTS) + 0.0)
    gy, gx = np.meshgrid(sub, sub, indexing="ij")
    jit = rng.random((len(cell), NPTS * NPTS, 2))
    qx = (c[:, None] + (gx.ravel()[None] + jit[..., 0]) / NPTS) * f + pad
    qy = (r[:, None] + (gy.ravel()[None] + jit[..., 1]) / NPTS) * f + pad
    lat = wg.lat_of_world_y((qy - pad + area["y0"] * f) / 2 ** (Z + 8))
    mpp = 40075016.7 * np.cos(np.radians(lat)) / 2 ** (Z + 8)
    qx, qy, mpp = qx.ravel(), qy.ravel(), mpp.ravel()
    ground = dem[qy.astype(int), qx.astype(int)]
    on_land = (ground >= -0.5).reshape(len(cell), -1)
    # A cell the analysis calls land but whose points all miss it keeps them all.
    on_land[~on_land.any(axis=1)] = True
    print(f"  {len(qx):,} points, {on_land.mean():.1%} on land; marching", flush=True)

    hz = np.empty((len(qx), NAZ), np.uint8)
    t0 = time.time()
    horizons(dem, qx, qy, mpp, hz)
    print(f"  horizons in {time.time() - t0:.0f} s", flush=True)

    os.makedirs("cache/horizons", exist_ok=True)
    path = f"cache/horizons/{a.area}.npz"
    np.savez(path + ".tmp.npz", hz=hz.reshape(len(cell), NPTS * NPTS, NAZ), land=on_land,
             scale=HZ_SCALE, offset=HZ_OFFSET)
    os.replace(path + ".tmp.npz", path)
    ang = hz.astype(np.float32) * HZ_SCALE + HZ_OFFSET
    print(f"  {path}: mean horizon {ang.mean():.1f}°, 99th percentile {np.percentile(ang, 99):.1f}°")


if __name__ == "__main__":
    main()
