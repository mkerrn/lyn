#!/usr/bin/env python3
"""
Climate layers on the level-13 cell grid, from the MET Nordic analysis.

    python3 fetch_climate.py                          # everything, 2016–2025
    python3 fetch_climate.py --from 2019-01-01 --to 2019-01-31 --layers temp,rain
    python3 fetch_climate.py --write-only             # rewrite the files from the cache

Reads the hourly 1 km analysis from thredds.met.no by OPeNDAP, every second
point (2 km, about the cell size), and gives each land cell of the area the
point nearest its centre. Hours are turned into daily stats per cell in local
solar time (UTC + longitude/15 h), the days into half-month sums, and only
those are kept: cache/wx/<area>/<layer>/<year>-<period>.npz, so a stopped run
picks up at the next missing half-month. At the end each layer is written as
<layer>-<area>-<year>.bin.gz, one per whole year in the cache, plus the mean
over those years, and listed in data/wx/index.json with the years it has. The files are too big for this repository, so
they go to a clone of the data repository next to it (--out), which GitHub
Pages serves (--url); the index points there.

The area is the one make_thunder_days.py put in the index; land is every 1 km
point the analysis counts as at least half land, lakes included.
"""

import argparse, json, os, subprocess, sys, threading, time, warnings
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import numpy as np
import requests
from numba import njit, prange

import wxgrid as wg

L = 13
STRIDE = 2
MIN_HOURS = 18         # a cell-day with fewer hours than this is left out
THREDDS = "https://thredds.met.no/thredds/dodsC/"
DEADLINE = 60          # s for a whole reply; an hour of the area is 12 MB
RERUN_END = np.datetime64("2025-11-01")  # metpparchivev4 runs to the end of October 2025
CACHE = "cache/wx"
OUT = "../weatherdata/wx"
URL = "https://mkerrn.github.io/weatherdata/wx"

CREDIT = "MET Nordic analysis © Meteorologisk institutt"
VARS = {"t": "air_temperature_2m", "rh": "relative_humidity_2m",
        "ws": "wind_speed_10m", "pr": "precipitation_amount",
        "sw": "integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time"}

# Sunshine from radiation: with k = G / G_cs, the sunny share of the hour is
# clamp((k - k0) / (k1 - k0), 0, 1), and no sun below MIN_SUN_EL. The
# thresholds rise as the sun gets lower, where overcast light is bright next
# to a weak clear sky: with x = 1/sin(elevation) - 1, k0 = a + b·x and
# k1 = k0 + c + d·x. Fitted to the Frost stations by calibrate_sun.py; the
# fit is in PLAN.md.
SUN_FIT = (0.40, 0.025, 0.55, 0.05)
MIN_SUN_EL = 3.0
SUBSTEPS = 4           # sun positions an hour, for the low sun and the horizons

# Each layer: the variables it needs, its daily stats, and how its bands are
# made from them and stored. A layer with "from" is the sum of those layers'
# cached half-months, band by band, and is never fetched itself. A band's value is the half-month mean of its
# stat for "mean" bands, and the half-month total for "sum" bands.
T8 = {"dtype": 1, "scale": 0.5, "offset": -60.0, "nodata": 255}
DAYS8 = {"dtype": 1, "scale": 0.1, "offset": 0.0, "nodata": 255}
HOURS8 = {"dtype": 1, "scale": 0.1, "offset": 0.0, "nodata": 255}
MM16 = {"dtype": 3, "scale": 0.1, "offset": 0.0, "nodata": 65535}
LAYERS = {
    "temp": {
        "vars": ["t"],
        "meta": {"label": "Temperature",
                 "note": "Day is the mean of the daily highest temperature, night the mean of the "
                         "daily lowest, at 2 m, in local solar time."},
        "bands": [{"id": "tmax", "label": "Day", "unit": "°C", "agg": "mean", "ramp": "temp", "enc": T8},
                  {"id": "tmin", "label": "Night", "unit": "°C", "agg": "mean", "ramp": "temp", "enc": T8}]},
    "feels": {
        "vars": ["t", "rh", "ws"],
        "meta": {"label": "Feels like",
                 "note": "Hourly apparent temperature: wind chill below 10 °C, Steadman's apparent "
                         "temperature from temperature, humidity and wind above. Day is the mean "
                         "daily highest, night the mean daily lowest. Shade and sun are not counted."},
        "bands": [{"id": "fmax", "label": "Day", "unit": "°C", "agg": "mean", "ramp": "temp", "enc": T8},
                  {"id": "fmin", "label": "Night", "unit": "°C", "agg": "mean", "ramp": "temp", "enc": T8}]},
    "wind": {
        "vars": ["ws"],
        "meta": {"label": "Wind",
                 "note": "The mean of each day's strongest hourly wind at 10 m. MET Nordic has no "
                         "gusts, so gusts run well above this."},
        "bands": [{"id": "wmax", "label": "Daily strongest wind", "unit": "m/s", "agg": "mean", "ramp": "seq",
                   "enc": {"dtype": 1, "scale": 0.2, "offset": 0.0, "nodata": 255}}]},
    "humid": {
        "vars": ["rh"],
        "meta": {"label": "Humidity",
                 "note": "Relative humidity at 2 m, over the whole day and over the hours with the "
                         "sun above the horizon. Polar night has no daylight hours."},
        "bands": [{"id": "rh", "label": "All day", "unit": "%", "agg": "mean", "ramp": "seq",
                   "enc": {"dtype": 1, "scale": 1.0, "offset": 0.0, "nodata": 255}},
                  {"id": "rhday", "label": "Daylight", "unit": "%", "agg": "mean", "ramp": "seq",
                   "enc": {"dtype": 1, "scale": 1.0, "offset": 0.0, "nodata": 255}}]},
    "precip": {
        "from": ["rain", "snow"],
        "meta": {"label": "Precipitation",
                 "note": "All precipitation, rain and snow together, snow as mm of water. Made "
                         "from the Rain and Snow layers, so it has no days of its own."},
        "bands": [{"id": "mm", "label": "Amount", "unit": "mm", "agg": "sum", "ramp": "seq", "enc": MM16}]},
    "rain": {
        "vars": ["t", "pr"],
        "meta": {"label": "Rain",
                 "note": "Precipitation that falls as rain: all of it at 2 °C and above, none at "
                         "0 °C and below, a share in between. The rest is under Snow."},
        "bands": [{"id": "mm", "label": "Amount", "unit": "mm", "agg": "sum", "ramp": "seq", "enc": MM16},
                  {"id": "d1", "label": "Days ≥ 1 mm", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8},
                  {"id": "d10", "label": "Days ≥ 10 mm", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8}]},
    "snow": {
        "vars": ["t", "pr"],
        "meta": {"label": "Snow",
                 "note": "Precipitation that falls as snow, in mm of water: all of it at 0 °C and "
                         "below, none at 2 °C and above. 1 mm is roughly 1 cm of fresh snow."},
        "bands": [{"id": "mm", "label": "Amount (water)", "unit": "mm", "agg": "sum", "ramp": "seq", "enc": MM16},
                  {"id": "d1", "label": "Days ≥ 1 mm", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8}]},
    "sun": {
        "vars": ["sw"],
        "meta": {"label": "Sun (sky)",
                 "note": "Sunshine estimated from the analysed solar radiation against a clear "
                         "sky, fitted to the sunshine recorders at MET Norway's stations. It is "
                         "the sky's sunshine: mountains in the way are not counted, see Sun seen "
                         "from the ground for that."},
        "bands": [{"id": "hours", "label": "Sun hours a day", "unit": "h", "agg": "mean", "ramp": "seq", "enc": HOURS8},
                  {"id": "d1", "label": "Days ≥ 1 h sun", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8},
                  {"id": "d3", "label": "Days ≥ 3 h sun", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8},
                  {"id": "d6", "label": "Days ≥ 6 h sun", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8}]},
    "sunground": {
        "vars": ["sw"],
        "meta": {"label": "Sun seen from the ground",
                 "note": "The sky's sunshine, shaded by the terrain: 16 points in each cell, each "
                         "with its own horizon out to 40 km. A day counts at the share of the "
                         "points that saw the sun that long, so it is what to expect at a random "
                         "spot in the cell, not a promise for any one spot. Cloud gaps and "
                         "terrain are taken as independent within the hour."},
        "bands": [{"id": "d15", "label": "Days sun seen ≥ 15 min", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8},
                  {"id": "d60", "label": "Days sun seen ≥ 1 h", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8},
                  {"id": "d180", "label": "Days sun seen ≥ 3 h", "unit": "days", "agg": "sum", "ramp": "seq", "enc": DAYS8},
                  {"id": "hours", "label": "Hours of direct sun a day", "unit": "h", "agg": "mean", "ramp": "seq", "enc": HOURS8}]},
}

# Hour of day: a mean day per month on coarser cells, the mean over all the
# whole years, one file per layer. Each quantity is the hourly mean of what
# the layer shows; rain and snow give the chance of at least 0.1 mm.
HL = 11
HOURLY = {"temp": {"q": "t", "label": "Temperature", "unit": "°C", "enc": T8},
          "feels": {"q": "f", "label": "Feels like", "unit": "°C", "enc": T8},
          "wind": {"q": "ws", "label": "Wind", "unit": "m/s", "enc": {"dtype": 1, "scale": 0.2, "offset": 0.0, "nodata": 255}},
          "humid": {"q": "rh", "label": "Humidity", "unit": "%", "enc": {"dtype": 1, "scale": 1.0, "offset": 0.0, "nodata": 255}},
          "rain": {"q": "rain", "label": "Chance of rain (≥ 0.1 mm)", "unit": "%", "enc": {"dtype": 1, "scale": 0.5, "offset": 0.0, "nodata": 255}},
          "snow": {"q": "snow", "label": "Chance of snow (≥ 0.1 mm)", "unit": "%", "enc": {"dtype": 1, "scale": 0.5, "offset": 0.0, "nodata": 255}},
          "sun": {"q": "sky", "label": "Sun", "unit": "min", "enc": {"dtype": 1, "scale": 0.25, "offset": 0.0, "nodata": 255}},
          "sunground": {"q": "ground", "label": "Sun seen", "unit": "min", "enc": {"dtype": 1, "scale": 0.25, "offset": 0.0, "nodata": 255}}}
HQ = ["t", "f", "ws", "rh", "rain", "snow", "sky", "ground"]
HVARS = ["t", "rh", "ws", "pr", "sw"]


# ---------- the cells ----------

def setup_cells(area):
    """Land cells of the area and, for each, its point in the strided block
    that is downloaded every hour. Cached, as it needs the 1 km land mask."""
    path = f"{CACHE}/{area['id']}/cells.npz"
    if os.path.exists(path):
        return dict(np.load(path))
    print("fetching the land mask")
    laf = dods(THREDDS + "metpparchivev4/2020/01/01/met_analysis_1_0km_nordic_20200101T00Z.nc",
               ["land_area_fraction"], "")["land_area_fraction"].reshape(wg.LCC_NY, wg.LCC_NX)
    rlat, clon = wg.cell_centres(L, area["x0"], area["y0"], area["nx"], area["ny"])
    lat, lon = np.meshgrid(rlat, clon, indexing="ij")
    i, j = wg.lcc_index(lat, lon)
    i, j = np.round(i).astype(int), np.round(j).astype(int)
    ins = (i >= 0) & (i < wg.LCC_NX) & (j >= 0) & (j < wg.LCC_NY)
    land = np.zeros(ins.shape, bool)
    land[ins] = laf[j[ins], i[ins]] >= 0.5
    cell = np.flatnonzero(land)
    i, j = i.ravel()[cell], j.ravel()[cell]
    c0, r0 = max(i.min() - 1, 0), max(j.min() - 1, 0)
    nc = (min(i.max() + 1, wg.LCC_NX - 1) - c0) // STRIDE + 1
    nr = (min(j.max() + 1, wg.LCC_NY - 1) - r0) // STRIDE + 1
    pc = np.clip(np.round((i - c0) / STRIDE).astype(int), 0, nc - 1)
    pick = np.clip(np.round((j - r0) / STRIDE).astype(int), 0, nr - 1) * nc + pc
    c = {"cell": cell, "pick": pick, "lat": lat.ravel()[cell], "lon": lon.ravel()[cell],
         "box": np.array([r0, nr, c0, nc])}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.savez(path, **c)
    return c


def setup_sun(area, cells):
    """What the sun layers and the hour-of-day files need on top of the
    cells: each cell's model height for the clear sky, the terrain horizons
    of its points (make_horizons.py), and its level-HL cell."""
    path = f"{CACHE}/{area['id']}/alt.npz"
    if not os.path.exists(path):
        r0, nr, c0, nc = cells["box"]
        sl = f"[{r0}:{STRIDE}:{r0 + STRIDE * (nr - 1)}][{c0}:{STRIDE}:{c0 + STRIDE * (nc - 1)}]"
        alt = dods(THREDDS + "metpparchivev4/2020/01/01/met_analysis_1_0km_nordic_20200101T00Z.nc",
                   ["altitude"], sl, nr * nc)["altitude"]
        np.savez(path, alt=alt[cells["pick"]])
    out = {"alt": np.load(path)["alt"].astype(np.float32)}
    hpath = f"cache/horizons/{area['id']}.npz"
    if os.path.exists(hpath):
        z = np.load(hpath)
        out["hz"], out["land"] = z["hz"], z["land"]
        out["hz_scale"], out["hz_offset"] = float(z["scale"]), float(z["offset"])
    # Level-HL cells: the land ones only, numbered in order.
    k = 2 ** (L - HL)
    r, c = np.divmod(cells["cell"], area["nx"])
    gx, gy = (area["x0"] + c) // k, (area["y0"] + r) // k
    hx0, hy0 = area["x0"] // k, area["y0"] // k
    hnx, hny = (area["x0"] + area["nx"] - 1) // k - hx0 + 1, (area["y0"] + area["ny"] - 1) // k - hy0 + 1
    flat = (gy - hy0) * hnx + (gx - hx0)
    out["hcells"], out["hof"] = np.unique(flat, return_inverse=True)
    out["harea"] = {"x0": int(hx0), "y0": int(hy0), "nx": int(hnx), "ny": int(hny)}
    return out


@njit(parallel=True, cache=True)
def ground_minutes(idx, sky_s, el, az, hz, scale, offset, min_el, out):
    """Adds to out[c, p] the minutes point p of cell c saw the sun this hour:
    60 × the sunny share of the hour × the share of the sub-steps with the
    sun above the point's horizon. Only cells idx, the ones with sun."""
    npt, naz = hz.shape[1], hz.shape[2]
    nsub = el.shape[1]
    for n in prange(len(idx)):
        c = idx[n]
        for i in range(nsub):
            e = el[c, i]
            if e < min_el:
                continue
            pos = az[c, i] / (360.0 / naz)
            a0 = int(pos) % naz
            a1 = (a0 + 1) % naz
            w = pos - int(pos)
            for p in range(npt):
                h = (hz[c, p, a0] * (1 - w) + hz[c, p, a1] * w) * scale + offset
                if e > h:
                    out[c, p] += 60.0 * sky_s[c] / nsub


def clear_sky(el, alt):
    """Haurwitz clear-sky global irradiance, W/m², 10 % more a km up."""
    cz = np.sin(np.radians(el))
    g = np.where(cz > 0.01, 1098 * cz * np.exp(-0.057 / np.maximum(cz, 0.01)), 0)
    return g * (1 + 0.1 * alt / 1000)


def sunshine(G, el, alt, fit=SUN_FIT):
    """Sunny share of the hour before, from its mean radiation G (W/m²) and
    the sun's elevation at the sub-steps (cells × SUBSTEPS): the clearness
    share, and that counted only for the sub-steps with the sun high enough."""
    gcs = clear_sky(el, alt[:, None]).mean(axis=1)
    k = np.where(gcs > 1, G / np.maximum(gcs, 1), 0)
    x = np.clip(1 / np.clip(np.sin(np.radians(el)).mean(axis=1), 0.02, 1) - 1, 0, 15)
    a, b, c, d = fit
    k0 = a + b * x
    s = np.clip((k - k0) / (c + d * x), 0, 1)
    return s, s * (el >= MIN_SUN_EL).mean(axis=1)


# ---------- downloading ----------

def dods(url, names, sl, size=None):
    """Variables from one OPeNDAP .dods request, as flat float32 arrays.
    None if the file doesn't exist (an hour missing from the archive), or if
    the server keeps failing for about ten minutes: that hour is then left
    out rather than stopping a run of many hours. With no network at all it
    waits for as long as it takes, so a dropped connection loses nothing.
    size: the number of values each array should have.

    Fetched with curl, as thredds.met.no can slow a connection to a trickle
    without closing it, before or during the reply, and only curl's
    --max-time puts a deadline on the whole request."""
    q = quote(",".join(f"{n}.{n}{sl}" for n in names), safe=",:.")
    attempt = 0
    while True:
        r = subprocess.run(["curl", "-s", "--max-time", str(DEADLINE), "--connect-timeout", "30",
                            "-w", "\n%{http_code}", f"{url}.dods?{q}"], capture_output=True)
        body, _, code = r.stdout.rpartition(b"\n")
        code = int(code or 0)
        try:
            if r.returncode in (6, 7) and not online():         # can't resolve or connect
                wait_online()
                continue
            if r.returncode == 28:
                raise TimeoutError(f"slower than {DEADLINE} s")
            if r.returncode:
                raise ConnectionError(f"curl exit {r.returncode}")
            if code == 404:
                return None
            if code == 429:
                time.sleep(60)                  # throttled: wait and try again, never give the hour up
                continue
            if 400 <= code < 500:
                raise RuntimeError(f"{code} for {url}")
            if code != 200:
                raise ConnectionError(f"HTTP {code}")
            b = body
            i = b.index(b"\nData:\n") + 7
            # The arrays come in the dataset's order, not the order asked for.
            dds = b[:i].decode()
            out = {}
            for n in sorted(names, key=lambda n: dds.index(f" {n}[")):
                cnt = int(np.frombuffer(b[i:i + 4], ">u4")[0])
                i += 8
                out[n] = np.frombuffer(b[i:i + 4 * cnt], ">f4").astype(np.float32)
                i += 4 * cnt
                if len(out[n]) != (size or cnt):
                    raise ValueError(f"short response from {url}")      # a cut connection: try again
            return out
        except (ConnectionError, ValueError, TimeoutError) as err:
            e = err
        attempt += 1
        if attempt == 9:
            print(f"    giving up on {url.rsplit('/', 1)[-1]}: {e}", flush=True)
            return None
        time.sleep(min(5 * 2 ** (attempt - 1), 120))


def online():
    """Whether the network is up at all, as against thredds.met.no failing."""
    for host in ("https://www.met.no", "https://github.com"):
        try:
            requests.head(host, timeout=10)
            return True
        except requests.RequestException:
            pass
    return False


_offline = threading.Lock()


def wait_online():
    """Blocks until the network is back; one thread reports it."""
    if _offline.acquire(blocking=False):
        try:
            print("    network down, waiting for it", flush=True)
            while not online():
                time.sleep(30)
            print("    network back", flush=True)
        finally:
            _offline.release()
    else:
        with _offline:
            pass


def hour_url(h):
    """The analysis valid at hour h (hours since 1970, UTC)."""
    d = np.datetime64(int(h), "h")
    day = d.astype("datetime64[D]")
    base = "metpparchivev4" if day < RERUN_END else "metpparchive"
    s = str(d).replace("-", "")
    return f"{THREDDS}{base}/{str(day).replace('-', '/')}/met_analysis_1_0km_nordic_{s[:8]}T{s[9:11]}Z.nc"


def fetch_hours(hours, names, box, workers):
    """Yields (hour, {var: block}) in order, several downloads in flight."""
    r0, nr, c0, nc = box
    sl = f"[0][{r0}:{STRIDE}:{r0 + STRIDE * (nr - 1)}][{c0}:{STRIDE}:{c0 + STRIDE * (nc - 1)}]"
    with ThreadPoolExecutor(workers) as ex:
        q = deque()
        it = iter(hours)
        for h in it:
            q.append((h, ex.submit(dods, hour_url(h), names, sl, nr * nc)))
            if len(q) >= 2 * workers:
                break
        while q:
            h, f = q.popleft()
            nxt = next(it, None)
            if nxt is not None:
                q.append((nxt, ex.submit(dods, hour_url(nxt), names, sl, nr * nc)))
            yield h, f.result()


# ---------- hours to days to half-months ----------

def feels_like(t, rh, ws):
    """Wind chill below 10 °C, Steadman's apparent temperature above."""
    v = (ws * 3.6) ** 0.16
    wc = np.where(ws * 3.6 > 4.8, 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v, t)
    e = rh / 100 * 6.105 * np.exp(17.27 * t / (237.7 + t))
    return np.where(t <= 10, wc, t + 0.33 * e - 0.70 * ws - 4.0)


class Day:
    """Running daily stats for the cells whose solar day it is."""
    KEYS = ["n", "tmax", "tmin", "fmax", "fmin", "wmax", "rh", "rhday", "nday", "rain", "snow", "sky"]

    def __init__(self, n, npts=0):
        self.g = np.zeros((n, npts), np.float32) if npts else None   # minutes each point saw the sun
        inf = np.full(n, np.inf, np.float32)
        self.a = {k: np.zeros(n, np.float32) for k in self.KEYS}
        for k in ("tmax", "fmax", "wmax"):
            self.a[k] = -inf.copy()
        for k in ("tmin", "fmin"):
            self.a[k] = inf.copy()

    def add(self, m, v, sun):
        a = self.a
        a["n"][m] += 1
        if "t" in v:
            t = v["t"][m]
            a["tmax"][m] = np.maximum(a["tmax"][m], t)
            a["tmin"][m] = np.minimum(a["tmin"][m], t)
        if "ws" in v:
            a["wmax"][m] = np.maximum(a["wmax"][m], v["ws"][m])
        if "rh" in v:
            rh = v["rh"][m]
            a["rh"][m] += rh
            day = sun[m] > 0
            a["rhday"][m] += np.where(day, rh, 0)
            a["nday"][m] += day
        if "t" in v and "rh" in v and "ws" in v:
            f = feels_like(v["t"][m], v["rh"][m], v["ws"][m])
            a["fmax"][m] = np.maximum(a["fmax"][m], f)
            a["fmin"][m] = np.minimum(a["fmin"][m], f)
        if "pr" in v:
            p, snowy = v["pr"][m], np.clip((2 - v["t"][m]) / 2, 0, 1)
            a["rain"][m] += p * (1 - snowy)
            a["snow"][m] += p * snowy
        if "sky" in v:
            a["sky"][m] += v["sky"][m]
        if "ground" in v and self.g is not None:
            self.g[m] += v["ground"][m]

    def stats(self, landw=None):
        """Daily values per band id, NaN where the cell-day is incomplete."""
        a = self.a
        n = a["n"]
        ok = n >= MIN_HOURS
        k = np.where(ok, 24 / np.maximum(n, 1), np.nan)    # amounts scaled up for a missing hour
        rain, snow = a["rain"] * k, a["snow"] * k
        bad = np.where(ok, 1, np.nan)
        return {
            "temp": {"tmax": a["tmax"] * bad, "tmin": a["tmin"] * bad},
            "feels": {"fmax": a["fmax"] * bad, "fmin": a["fmin"] * bad},
            "wind": {"wmax": a["wmax"] * bad},
            "humid": {"rh": a["rh"] / np.maximum(n, 1) * bad,
                      "rhday": np.where(a["nday"] > 0, a["rhday"] / np.maximum(a["nday"], 1), np.nan) * bad},
            "rain": {"mm": rain, "d1": (rain >= 1) * bad, "d10": (rain >= 10) * bad},
            "snow": {"mm": snow, "d1": (snow >= 1) * bad},
            "sun": {"hours": a["sky"] * k / 60, "d1": (a["sky"] * k >= 60) * bad,
                    "d3": (a["sky"] * k >= 180) * bad, "d6": (a["sky"] * k >= 360) * bad},
            "sunground": {} if self.g is None else {
                # The share of the cell's land points that saw the sun that long.
                "d15": ((self.g * k[:, None] >= 15) * landw).sum(axis=1) * bad,
                "d60": ((self.g * k[:, None] >= 60) * landw).sum(axis=1) * bad,
                "d180": ((self.g * k[:, None] >= 180) * landw).sum(axis=1) * bad,
                "hours": (self.g * landw).sum(axis=1) * k / 60},
        }


def period_days(year, p):
    """Solar days (since 1970) of half-month p of a year."""
    m = p // 2 + 1
    first = np.datetime64(f"{year}-{m:02d}-{1 if p % 2 == 0 else 16:02d}")
    end = (np.datetime64(f"{year}-{m:02d}") + 1).astype("datetime64[D]") if p % 2 else first + 15
    return np.arange(first.astype(np.int64), end.astype(np.int64))


def run_period(year, p, layers, cells, workers, sunc=None):
    """Downloads one half-month and saves the half-month sums of each layer,
    and of the hour of day ("hours" among the layers)."""
    days = period_days(year, p)
    lon = cells["lon"]
    names = {v for l in layers if l in LAYERS for v in LAYERS[l].get("vars", [])}
    if "hours" in layers:
        names |= set(HVARS)
    if "pr" in names:
        names |= {"t"}                            # the rain/snow split needs temperature
    names = sorted(names)
    ground = "sunground" in layers or "hours" in layers
    if ground and "hz" not in sunc:
        sys.exit("no horizons: run make_horizons.py first")
    landw = None
    if ground:
        landw = sunc["land"] / sunc["land"].sum(axis=1, keepdims=True).astype(np.float32)
    npts = sunc["hz"].shape[1] if ground else 0
    if "hours" in layers:
        nh = len(sunc["hcells"])
        hsum = np.zeros((len(HQ), 24 * nh), np.float64)
        hcnt = np.zeros(24 * nh, np.int64)
    # Each hourly field stands for the hour before its time stamp, so it goes
    # to the solar day of the half hour before.
    shift = lon * 240 - 1800
    h0 = int((days[0] * 86400 + 1800 - lon.max() * 240) // 3600)
    h1 = int(-(-((days[-1] + 1) * 86400 + 1800 - lon.min() * 240) // 3600))
    n = len(lon)
    open_days, sums, counts = {}, {}, {}
    missing = 0

    def close(d):
        st = open_days.pop(d).stats(landw)
        for l in layers:
            if l == "hours":
                continue
            for b, v in st[l].items():
                key = (l, b)
                if key not in sums:
                    sums[key], counts[key] = np.zeros(n, np.float64), np.zeros(n, np.uint8)
                ok = ~np.isnan(v)
                sums[key][ok] += v[ok]
                counts[key] += ok

    for h, v in fetch_hours(range(h0, h1 + 1), [VARS[k] for k in names], cells["box"], workers):
        t = h * 3600
        dcell = np.floor((t + shift) / 86400).astype(np.int64)
        if v is None:
            missing += 1
        else:
            v = {k: v[VARS[k]][cells["pick"]] for k in names}
            if "t" in v:
                v["t"] = v["t"] - 273.15
            if "rh" in v:
                v["rh"] = np.clip(v["rh"] * 100, 0, 100)
            sun = wg.sun_elevation(np.full(n, t - 1800), cells["lat"], lon) if "rh" in v else None
            if "sw" in v:
                # The sun at the middle of each quarter of the hour before.
                ts = t - 3600 + (np.arange(SUBSTEPS) + 0.5) * 3600 / SUBSTEPS
                el, az = wg.sun_position(ts[None, :], cells["lat"][:, None], lon[:, None])
                s_k, s_hour = sunshine(np.nan_to_num(v.pop("sw")) / 3600, el, sunc["alt"])
                v["sky"] = 60 * s_hour
                if ground:
                    g = np.zeros((n, npts), np.float32)
                    ground_minutes(np.flatnonzero(s_hour > 0), s_k.astype(np.float32),
                                   el.astype(np.float32), az.astype(np.float32), sunc["hz"],
                                   sunc["hz_scale"], sunc["hz_offset"], MIN_SUN_EL, g)
                    v["ground"] = g
            for d in np.unique(dcell):
                if days[0] <= d <= days[-1]:
                    open_days.setdefault(d, Day(n, npts)).add(np.flatnonzero(dcell == d), v, sun)
            if "hours" in layers:
                # The local solar hour each cell's half hour before falls in.
                inp = (dcell >= days[0]) & (dcell <= days[-1])
                sh = np.floor(((t - 1800 + lon * 240) % 86400) / 3600).astype(np.int64)
                key = (sh * nh + sunc["hof"])[inp]
                snowy = np.clip((2 - v["t"]) / 2, 0, 1)
                q = {"t": v["t"], "f": feels_like(v["t"], v["rh"], v["ws"]), "ws": v["ws"], "rh": v["rh"],
                     "rain": 100.0 * (v["pr"] * (1 - snowy) >= 0.1), "snow": 100.0 * (v["pr"] * snowy >= 0.1),
                     "sky": v["sky"], "ground": (v["ground"] * landw).sum(axis=1)}
                for qi, name in enumerate(HQ):
                    hsum[qi] += np.bincount(key, q[name][inp], minlength=24 * nh)
                hcnt += np.bincount(key, minlength=24 * nh)
        for d in [d for d in open_days if d < dcell.min()]:
            close(d)
    for d in list(open_days):
        close(d)

    if "hours" in layers:
        path = f"{CACHE}/{cells['area']}/hours/{year}-{p:02d}.npz"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        np.savez_compressed(path + ".tmp.npz", sums=hsum.reshape(len(HQ), 24, nh).astype(np.float32),
                            n=hcnt.reshape(24, nh).astype(np.uint16))
        os.replace(path + ".tmp.npz", path)
    for l in layers:
        if l == "hours":
            continue
        out = {}
        for b in LAYERS[l]["bands"]:
            out[b["id"]] = sums[(l, b["id"])].astype(np.float32)
            out[b["id"] + "_n"] = counts[(l, b["id"])]
        path = f"{CACHE}/{cells['area']}/{l}/{year}-{p:02d}.npz"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        np.savez_compressed(path + ".tmp.npz", ndays=len(days), **out)
        os.replace(path + ".tmp.npz", path)
    return missing


# ---------- writing ----------

def encode(v, enc):
    raw = np.round((v - enc["offset"]) / enc["scale"])
    hi = enc["nodata"] - 1
    return np.where(np.isnan(v), enc["nodata"], np.clip(raw, 0, hi)).astype(wg.DTYPES[enc["dtype"]])


def write_layer(l, area, cells, out, url):
    """Per-year files and the mean file from the cached half-months."""
    spec = LAYERS[l]
    ny_, nx_ = area["ny"], area["nx"]
    per_year = {}
    for y in wg.YEARS:
        # Only whole years: a part-built one would skew the mean and the year charts.
        paths = [[f"{CACHE}/{area['id']}/{s}/{y}-{p:02d}.npz" for s in spec.get("from", [l])]
                 for p in range(wg.NPERIODS)]
        if not all(os.path.exists(path) for ps in paths for path in ps):
            continue
        vals = {b["id"]: np.full((wg.NPERIODS, len(cells["cell"])), np.nan, np.float32) for b in spec["bands"]}
        for p, ps in enumerate(paths):
            zs = [np.load(path) for path in ps]
            for b in spec["bands"]:
                # The sources come from the same cell-days, so their counts are the same.
                s, c = sum(z[b["id"]] for z in zs), zs[0][b["id"] + "_n"].astype(np.float32)
                with np.errstate(invalid="ignore", divide="ignore"):
                    # Means over the days present; totals scaled up to the whole half-month.
                    v = s / c if b["agg"] == "mean" else s / c * int(zs[0]["ndays"])
                vals[b["id"]][p] = np.where(c > 0, v, np.nan)
        per_year[y] = vals

    def grid(v):
        g = np.full((wg.NPERIODS, ny_ * nx_), np.nan, np.float32)
        g[:, cells["cell"]] = v
        return g.reshape(wg.NPERIODS, ny_, nx_)

    def bands(vals):
        return [{"id": b["id"], **b["enc"], "data": encode(grid(vals[b["id"]]), b["enc"])} for b in spec["bands"]]

    files, total = {}, 0
    for y, vals in per_year.items():
        name = f"{l}-{area['id']}-{y}.bin.gz"
        total += wg.write_wxg(f"{out}/{name}", L, area["x0"], area["y0"], nx_, ny_, y, bands(vals))
        files[str(y)] = f"{url}/{name}"
    if per_year:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)       # all-NaN where no year has the half-month
            mean = {b["id"]: np.nanmean([v[b["id"]] for v in per_year.values()], axis=0) for b in spec["bands"]}
        name = f"{l}-{area['id']}-mean.bin.gz"
        total += wg.write_wxg(f"{out}/{name}", L, area["x0"], area["y0"], nx_, ny_, 0, bands(mean))
        files["0"] = f"{url}/{name}"
        meta = {"id": l, **spec["meta"], "source": "MET Nordic", "attribution": CREDIT, "years": list(per_year),
                "bands": [{k: v for k, v in b.items() if k != "enc"} for b in spec["bands"]]}
        wg.update_index(area, meta, files)
    print(f"  {l}: {len(files)} files, {total / 1e6:.1f} MB")
    return total


def write_hours(area, sunc, out, url, layers):
    """One file per layer with its mean day per month, over the whole years
    in the cache: WXG1 at level HL, a band per month, the 24 local solar
    hours as its periods."""
    ha, nh = sunc["harea"], len(sunc["hcells"])
    sums = np.zeros((len(HQ), 12, 24, nh), np.float64)
    cnt = np.zeros((12, 24, nh), np.float64)
    years = []
    for y in wg.YEARS:
        paths = [f"{CACHE}/{area['id']}/hours/{y}-{p:02d}.npz" for p in range(wg.NPERIODS)]
        if not all(os.path.exists(x) for x in paths):
            continue
        years.append(y)
        for p, x in enumerate(paths):
            z = np.load(x)
            sums[:, p // 2] += z["sums"]
            cnt[p // 2] += z["n"]
    if not years:
        print("  hours: no whole year yet")
        return 0
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = sums / cnt
    with open(wg.INDEX) as f:
        idx = json.load(f)
    total = 0
    for l in layers:
        if l not in HOURLY or not any(x["id"] == l for x in idx["layers"]):
            continue
        h = HOURLY[l]
        g = np.full((24, ha["ny"] * ha["nx"]), np.nan, np.float32)
        bands = []
        for m in range(12):
            g[:, sunc["hcells"]] = mean[HQ.index(h["q"]), m]
            bands.append({"id": f"m{m + 1:02d}", **h["enc"],
                          "data": encode(g.reshape(24, ha["ny"], ha["nx"]), h["enc"])})
        name = f"{l}-{area['id']}-hours.bin.gz"
        total += wg.write_wxg(f"{out}/{name}", HL, ha["x0"], ha["y0"], ha["nx"], ha["ny"], 0, bands)
        layer = next(x for x in idx["layers"] if x["id"] == l)
        layer["hours"] = dict(layer.get("hours", {}), **{area["id"]: {
            "url": f"{url}/{name}", "label": h["label"], "unit": h["unit"], "years": years}})
    with open(wg.INDEX, "w") as f:
        json.dump(idx, f, indent=1, ensure_ascii=False)
    print(f"  hours: {len(years)} years, {total / 1e6:.1f} MB")
    return total


# ---------- main ----------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="start", default="2016-01-01")
    p.add_argument("--to", dest="end", default="2025-12-31")
    p.add_argument("--area", default="no")
    p.add_argument("--layers", default=",".join([*LAYERS, "hours"]),
                   help="layers, and hours for the hour-of-day files")
    p.add_argument("--workers", type=int, default=1,
                   help="downloads in flight. MET asks for one at a time while thredds.met.no is "
                        "overloaded (status.met.no, October 2026); at most 4 otherwise")
    p.add_argument("--write-only", action="store_true")
    p.add_argument("--out", default=OUT, help="folder the files are written to")
    p.add_argument("--url", default=URL, help="where the map finds that folder; data/wx to try it locally")
    a = p.parse_args()
    layers = a.layers.split(",")
    for l in layers:
        if l not in LAYERS and l != "hours":
            sys.exit(f"unknown layer {l}; choose from {', '.join(LAYERS)} or hours")
    with open(wg.INDEX) as f:
        area = next((x for x in json.load(f)["areas"] if x["id"] == a.area), None)
    if not area or area["L"] != L:
        sys.exit(f"no level-{L} area {a.area} in {wg.INDEX}; run make_thunder_days.py first")
    cells = setup_cells(area)
    cells["area"] = a.area
    sunc = setup_sun(area, cells) if {"sun", "sunground", "hours"} & set(layers) else None
    print(f"area {a.area}: {len(cells['cell']):,} land cells, "
          f"{cells['box'][1]} × {cells['box'][3]} points an hour")

    if not a.write_only:
        start, end = np.datetime64(a.start), np.datetime64(a.end)
        # A layer made from others is fetched as those.
        fetch = list(dict.fromkeys(s for l in layers for s in LAYERS.get(l, {}).get("from", [l])))
        todo = []
        for y in wg.YEARS:
            for per in range(wg.NPERIODS):
                d = period_days(y, per).astype("datetime64[D]")
                if d[-1] < start or d[0] > end:
                    continue
                need = [l for l in fetch if not os.path.exists(f"{CACHE}/{a.area}/{l}/{y}-{per:02d}.npz")]
                if need:
                    todo.append((y, per, need))
        print(f"{len(todo)} half-months to fetch")
        t0 = time.time()
        for k, (y, per, need) in enumerate(todo):
            t1 = time.time()
            miss = run_period(y, per, need, cells, min(a.workers, 4), sunc)
            el = time.time() - t0
            print(f"  {y} {per // 2 + 1:>2}/{'a' if per % 2 == 0 else 'b'} {','.join(need)}: "
                  f"{time.time() - t1:.0f} s{f', {miss} hours missing' if miss else ''}; "
                  f"{k + 1}/{len(todo)}, about {el / (k + 1) * (len(todo) - k - 1) / 3600:.1f} h left",
                  flush=True)

    out, url = a.out.rstrip('/'), a.url.rstrip('/')
    total = sum(write_layer(l, area, cells, out, url) for l in layers if l in LAYERS)
    if "hours" in layers:
        total += write_hours(area, sunc, out, url, list(LAYERS))
    print(f"wrote {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
