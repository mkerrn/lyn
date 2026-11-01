#!/usr/bin/env python3
"""
Fits the sunshine-from-radiation estimate to measured sunshine.

    export FROST_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    python3 calibrate_sun.py              # fetch what is missing, then fit
    python3 calibrate_sun.py --fit-only

MET Nordic has no sunshine duration, so fetch_climate.py estimates it from
the hourly shortwave radiation G against a clear-sky G_cs (Haurwitz, a
little more with height): with k = G / G_cs the sunny share of the hour is
clamp((k − k0) / (k1 − k0), 0, 1), and no sun below 3° elevation, where
k0 = a + b·x and k1 = k0 + c + d·x rise as the sun gets lower
(x = 1/sin(elevation) − 1). This compares that with the hourly sunshine the
stations in Frost record (sum(duration_of_sunshine PT1H)), on a sample of
days in 2018–2023, and picks a, b, c and d for the daily sun hours and the
share of days past 1, 3 and 6 hours, which is what the bands show. A station's recorder sees its own terrain, so the model
is shaded by the station's horizon (make_horizons.py) before comparing:
what is fitted is the sky estimate, not the valleys.

The radiation at the stations is cached in cache/sun/, so a stopped fetch
resumes and a refit is instant. The strided point nearest each station is
used, as fetch_climate.py uses for the cells.
"""

import argparse, base64, os, sys, time

import numpy as np
import requests

import fetch_climate as fc
import make_horizons as mh
import wxgrid as wg

SW = "integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time"
CACHE = "cache/sun"
STATIONS = ["SN18700", "SN23500", "SN56420", "SN97251", "SN91530", "SN68173", "SN90450",
            "SN12550", "SN16040", "SN53680", "SN49490", "SN50540", "SN11500", "SN91502",
            "SN55770", "SN38140", "SN39040", "SN50500", "SN76530", "SN82110"]
ELEMENT = "sum(duration_of_sunshine PT1H)"
EVERY = 6              # every 6th day
START, END = "2018-01-01", "2024-01-01"
MIN_EL, SUBSTEPS = fc.MIN_SUN_EL, fc.SUBSTEPS


def frost(client_id, path, params):
    tok = base64.b64encode(f"{client_id}:".encode()).decode()
    for attempt in range(5):
        r = requests.get("https://frost.met.no/" + path, params=params,
                         headers={"Authorization": f"Basic {tok}"}, timeout=120)
        if r.status_code in (404, 412):          # 412: nothing in that range
            return []
        if r.ok:
            return r.json()["data"]
        time.sleep(2 ** attempt)
    r.raise_for_status()


def stations(client_id):
    path = f"{CACHE}/stations.npz"
    if os.path.exists(path):
        return dict(np.load(path))
    d = frost(client_id, "sources/v0.jsonld", {"ids": ",".join(STATIONS), "fields": "id,name,geometry,masl"})
    d = sorted(d, key=lambda s: STATIONS.index(s["id"]))
    lon, lat = np.array([s["geometry"]["coordinates"] for s in d]).T
    st = {"id": np.array([s["id"] for s in d]), "name": np.array([s["name"] for s in d]),
          "lat": lat, "lon": lon, "masl": np.array([s.get("masl", 0) for s in d], float)}
    st["hz"] = mh.point_horizons(lat, lon)
    os.makedirs(CACHE, exist_ok=True)
    np.savez(path, **st)
    return st


def observed(client_id, st):
    """Sunshine minutes per station and hour (hours since 1970 of the
    referenceTime), NaN where there is no record."""
    path = f"{CACHE}/frost.npz"
    if os.path.exists(path):
        z = np.load(path)
        return z["h0"], z["obs"]
    h0 = np.datetime64(START, "h").astype(int)
    nh = np.datetime64(END, "h").astype(int) - h0
    obs = np.full((len(st["id"]), nh), np.nan, np.float32)
    for i, sid in enumerate(st["id"]):
        for y in range(int(START[:4]), int(END[:4])):
            d = frost(client_id, "observations/v0.jsonld",
                      {"sources": sid, "elements": ELEMENT, "referencetime": f"{y}-01-01/{y + 1}-01-01"})
            for x in d:
                h = np.datetime64(x["referenceTime"][:13], "h").astype(int) - h0
                if 0 <= h < nh:
                    obs[i, h] = x["observations"][0]["value"]
        print(f"  {st['name'][i]}: {np.count_nonzero(~np.isnan(obs[i])):,} hours", flush=True)
    np.savez(path, h0=h0, obs=obs)
    return h0, obs


def sun_steps(h, lat, lon):
    """Elevation and azimuth at the sub-steps of the hour before stamp h:
    arrays (stations, SUBSTEPS)."""
    t = h * 3600 - 3600 + (np.arange(SUBSTEPS) + 0.5) * 3600 / SUBSTEPS
    el, az = wg.sun_position(t[None, :], lat[:, None], lon[:, None])
    return el, az


def radiation(st, hours):
    """Mean shortwave W/m² over the hour before each stamp, at the stations."""
    path = f"{CACHE}/radiation.npz"
    got = {}
    if os.path.exists(path):
        z = np.load(path)
        got = dict(zip(z["hours"].tolist(), z["g"]))
    cells = np.load(f"cache/wx/no/cells.npz")
    r0, nr, c0, nc = cells["box"]
    i, j = wg.lcc_index(st["lat"], st["lon"])
    pick = (np.clip(np.round((j - r0) / fc.STRIDE).astype(int), 0, nr - 1) * nc
            + np.clip(np.round((i - c0) / fc.STRIDE).astype(int), 0, nc - 1))
    todo = [h for h in hours if h not in got]
    print(f"{len(got):,} hours cached, {len(todo):,} to fetch", flush=True)
    t0 = time.time()
    for k, (h, v) in enumerate(fc.fetch_hours(todo, [SW], cells["box"], 1)):
        got[h] = v[SW][pick] / 3600 if v is not None else np.full(len(pick), np.nan, np.float32)
        if (k + 1) % 250 == 0 or k + 1 == len(todo):
            hs = np.array(sorted(got))
            np.savez(path + ".tmp.npz", hours=hs, g=np.array([got[x] for x in hs]))
            os.replace(path + ".tmp.npz", path)
            el = time.time() - t0
            print(f"  {k + 1:,}/{len(todo):,}, about {el / (k + 1) * (len(todo) - k - 1) / 60:.0f} min left", flush=True)
    return got


def model(G, el, az, masl, hz, fit):
    """Modelled sunshine minutes in the hour, as fetch_climate.py does it,
    shaded by the station horizon. G (n,), el/az (n, SUBSTEPS), hz (n, 64)."""
    s = fc.sunshine(G, el, masl, fit)[0]
    pos = az / (360 / 64)
    a0 = np.floor(pos).astype(int) % 64
    w = pos - np.floor(pos)
    rows = np.arange(len(G))[:, None]
    hor = hz[rows, a0] * (1 - w) + hz[rows, (a0 + 1) % 64] * w
    vis = ((el >= MIN_EL) & (el > hor)).mean(axis=1)
    return 60 * s * vis


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--fit-only", action="store_true")
    a = p.parse_args()
    cid = os.environ.get("FROST_CLIENT_ID")
    if not cid and os.path.exists("cache/frost_id"):
        cid = open("cache/frost_id").read().strip()
    if not cid:
        sys.exit("set FROST_CLIENT_ID")
    st = stations(cid)
    h0, obs = observed(cid, st)

    # Sample days, and their hours with the sun up at some station.
    days = np.arange(np.datetime64(START), np.datetime64(END), EVERY).astype("datetime64[h]").astype(int)
    hours = (days[:, None] + np.arange(24)).ravel()
    up = np.array([sun_steps(h, st["lat"], st["lon"])[0].max() > MIN_EL for h in hours])
    hours = hours[up]
    if not a.fit_only:
        radiation(st, hours.tolist())
    z = np.load(f"{CACHE}/radiation.npz")
    hs, g = z["hours"], z["g"]
    print(f"{len(hs):,} hours with radiation")

    # Station-hours: the radiation hour before stamp h against the Frost
    # record whose referenceTime is h + lag.
    n = len(st["id"])
    def pairs(lag):
        idx = hs - h0 + lag
        ok = (idx >= 0) & (idx < obs.shape[1])
        o = obs[:, idx[ok]].T                                  # (hours, stations)
        G = g[ok]
        el, az = zip(*(sun_steps(h, st["lat"], st["lon"]) for h in hs[ok]))
        el, az = np.array(el), np.array(az)                     # (hours, stations, sub)
        sid = np.broadcast_to(np.arange(n), o.shape)
        hh = np.broadcast_to(hs[ok][:, None], o.shape)
        keep = ~np.isnan(o) & ~np.isnan(G)
        return (G[keep], el[keep], az[keep], st["masl"][sid[keep]], st["hz"][sid[keep]],
                o[keep], sid[keep], hh[keep])

    for lag in (-1, 0, 1):
        G, el, az, masl, hz, o, sid, hh = pairs(lag)
        m = model(G, el, az, masl, hz, fc.SUN_FIT)
        print(f"lag {lag:+d} h: {len(o):,} station-hours, correlation {np.corrcoef(m, o)[0, 1]:.3f}")
    lag = max((-1, 0, 1), key=lambda L: np.corrcoef(model(*pairs(L)[:5], fc.SUN_FIT), pairs(L)[5])[0, 1])
    G, el, az, masl, hz, o, sid, hh = pairs(lag)
    print(f"using lag {lag:+d} h")

    # Fitted to the station-days: the squared error of the daily sun hours,
    # plus the shares of days past 1, 3 and 6 h, where a point off counts
    # about as much as 0.3 h² of daily error.
    day = hh // 24
    _, inv = np.unique(day * 100 + sid, return_inverse=True)
    od = np.bincount(inv, o) / 60
    best = None
    for a_ in np.arange(0.1, 0.71, 0.05):
        for b_ in (0, 0.025, 0.05, 0.1):
            for c_ in np.arange(0.05, 1.21, 0.05):
                for d_ in (0, 0.05, 0.1):
                    md = np.bincount(inv, model(G, el, az, masl, hz, (a_, b_, c_, d_)), len(od)) / 60
                    f = np.mean((md - od) ** 2) + 30 * sum((np.mean(md >= t) - np.mean(od >= t)) ** 2
                                                            for t in (1, 3, 6))
                    if best is None or f < best[0]:
                        best = (f, (round(a_, 3), b_, round(c_, 3), d_))
    fit = best[1]
    m = model(G, el, az, masl, hz, fit)
    md = np.bincount(inv, m, len(od)) / 60
    print(f"\nfit a, b, c, d = {fit}: daily RMSE {np.sqrt(np.mean((md - od) ** 2)):.2f} h, "
          f"daily correlation {np.corrcoef(md, od)[0, 1]:.3f}, hourly RMSE {np.sqrt(np.mean((m - o) ** 2)):.1f} min, "
          f"bias {np.mean(m - o):+.2f} min an hour")

    # Daily totals per station and by month: the bands are built from these.
    print("\nsun hours per day, measured and modelled, by station:")
    for i in range(n):
        s = sid == i
        if not s.any():
            continue
        print(f"  {st['name'][i]:28s} {st['masl'][i]:5.0f} m  {o[s].sum() / 60 / len(np.unique(day[s])):5.2f}  "
              f"{m[s].sum() / 60 / len(np.unique(day[s])):5.2f}")
    mon = (hh.astype("datetime64[h]").astype("datetime64[M]").astype(int) % 12)
    print("by month, all stations:")
    for k in range(12):
        s = mon == k
        print(f"  {k + 1:2d}  {o[s].sum() / 60 / max(len(np.unique(day[s] * 100 + sid[s])), 1):5.2f}  "
              f"{m[s].sum() / 60 / max(len(np.unique(day[s] * 100 + sid[s])), 1):5.2f}")
    # Days with at least 1 / 3 / 6 h, the band thresholds.
    for t in (1, 3, 6):
        print(f"days with ≥ {t} h sun: measured {np.mean(od >= t):.1%}, modelled {np.mean(md >= t):.1%}")


if __name__ == "__main__":
    main()
