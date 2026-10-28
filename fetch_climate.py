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
<layer>-<area>-<year>.bin.gz, one per year, plus the mean over the years, and
listed in data/wx/index.json. The files are too big for this repository, so
they go to a clone of the data repository next to it (--out), which GitHub
Pages serves (--url); the index points there.

The area is the one make_thunder_days.py put in the index; land is every 1 km
point the analysis counts as at least half land, lakes included.
"""

import argparse, json, os, sys, threading, time, warnings
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

import wxgrid as wg

L = 13
STRIDE = 2
MIN_HOURS = 18         # a cell-day with fewer hours than this is left out
THREDDS = "https://thredds.met.no/thredds/dodsC/"
RERUN_END = np.datetime64("2025-11-01")  # metpparchivev4 runs to the end of October 2025
CACHE = "cache/wx"
OUT = "../weatherdata/wx"
URL = "https://mkerrn.github.io/weatherdata/wx"

CREDIT = "MET Nordic analysis © Meteorologisk institutt"
VARS = {"t": "air_temperature_2m", "rh": "relative_humidity_2m",
        "ws": "wind_speed_10m", "pr": "precipitation_amount"}

# Each layer: the variables it needs, its daily stats, and how its bands are
# made from them and stored. A band's value is the half-month mean of its
# stat for "mean" bands, and the half-month total for "sum" bands.
T8 = {"dtype": 1, "scale": 0.5, "offset": -60.0, "nodata": 255}
DAYS8 = {"dtype": 1, "scale": 0.1, "offset": 0.0, "nodata": 255}
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
}


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


# ---------- downloading ----------

_local = threading.local()


def dods(url, names, sl, size=None):
    """Variables from one OPeNDAP .dods request, as flat float32 arrays.
    None if the file doesn't exist (an hour missing from the archive), or if
    the server keeps failing for about ten minutes: that hour is then left
    out rather than stopping a run of many hours. With no network at all it
    waits for as long as it takes, so a dropped connection loses nothing.
    size: the number of values each array should have."""
    s = getattr(_local, "s", None) or requests.Session()
    _local.s = s
    q = ",".join(f"{n}.{n}{sl}" for n in names)
    attempt = 0
    while True:
        try:
            r = s.get(f"{url}.dods?{q}", timeout=180)
            if r.status_code == 404:
                return None
            if 400 <= r.status_code < 500 and r.status_code != 429:
                raise RuntimeError(f"{r.status_code} for {r.url}")
            r.raise_for_status()
            b = r.content
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
        except (requests.ConnectionError, requests.Timeout):
            if not online():
                wait_online()
                continue
            e = "no reply"
        except (requests.RequestException, ValueError) as err:
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
    KEYS = ["n", "tmax", "tmin", "fmax", "fmin", "wmax", "rh", "rhday", "nday", "rain", "snow"]

    def __init__(self, n):
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

    def stats(self):
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
        }


def period_days(year, p):
    """Solar days (since 1970) of half-month p of a year."""
    m = p // 2 + 1
    first = np.datetime64(f"{year}-{m:02d}-{1 if p % 2 == 0 else 16:02d}")
    end = (np.datetime64(f"{year}-{m:02d}") + 1).astype("datetime64[D]") if p % 2 else first + 15
    return np.arange(first.astype(np.int64), end.astype(np.int64))


def run_period(year, p, layers, cells, workers):
    """Downloads one half-month and saves the half-month sums of each layer."""
    days = period_days(year, p)
    lon = cells["lon"]
    names = sorted({v for l in layers for v in LAYERS[l]["vars"]})
    if "pr" in names:
        names = sorted(set(names) | {"t"})       # the rain/snow split needs temperature
    # Each hourly field stands for the hour before its time stamp, so it goes
    # to the solar day of the half hour before.
    shift = lon * 240 - 1800
    h0 = int((days[0] * 86400 + 1800 - lon.max() * 240) // 3600)
    h1 = int(-(-((days[-1] + 1) * 86400 + 1800 - lon.min() * 240) // 3600))
    n = len(lon)
    open_days, sums, counts = {}, {}, {}
    missing = 0

    def close(d):
        st = open_days.pop(d).stats()
        for l in layers:
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
            for d in np.unique(dcell):
                if days[0] <= d <= days[-1]:
                    open_days.setdefault(d, Day(n)).add(np.flatnonzero(dcell == d), v, sun)
        for d in [d for d in open_days if d < dcell.min()]:
            close(d)
    for d in list(open_days):
        close(d)

    for l in layers:
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
        vals = {b["id"]: np.full((wg.NPERIODS, len(cells["cell"])), np.nan, np.float32) for b in spec["bands"]}
        have = False
        for p in range(wg.NPERIODS):
            path = f"{CACHE}/{area['id']}/{l}/{y}-{p:02d}.npz"
            if not os.path.exists(path):
                continue
            have = True
            z = np.load(path)
            for b in spec["bands"]:
                s, c = z[b["id"]], z[b["id"] + "_n"].astype(np.float32)
                with np.errstate(invalid="ignore", divide="ignore"):
                    # Means over the days present; totals scaled up to the whole half-month.
                    v = s / c if b["agg"] == "mean" else s / c * int(z["ndays"])
                vals[b["id"]][p] = np.where(c > 0, v, np.nan)
        if have:
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
        meta = {"id": l, **spec["meta"], "source": "MET Nordic", "attribution": CREDIT,
                "bands": [{k: v for k, v in b.items() if k != "enc"} for b in spec["bands"]]}
        wg.update_index(area, meta, files)
    print(f"  {l}: {len(files)} files, {total / 1e6:.1f} MB")
    return total


# ---------- main ----------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="start", default="2016-01-01")
    p.add_argument("--to", dest="end", default="2025-12-31")
    p.add_argument("--area", default="no")
    p.add_argument("--layers", default=",".join(LAYERS))
    p.add_argument("--workers", type=int, default=6, help="downloads in flight, at most 8")
    p.add_argument("--write-only", action="store_true")
    p.add_argument("--out", default=OUT, help="folder the files are written to")
    p.add_argument("--url", default=URL, help="where the map finds that folder; data/wx to try it locally")
    a = p.parse_args()
    layers = a.layers.split(",")
    for l in layers:
        if l not in LAYERS:
            sys.exit(f"unknown layer {l}; choose from {', '.join(LAYERS)}")
    with open(wg.INDEX) as f:
        area = next((x for x in json.load(f)["areas"] if x["id"] == a.area), None)
    if not area or area["L"] != L:
        sys.exit(f"no level-{L} area {a.area} in {wg.INDEX}; run make_thunder_days.py first")
    cells = setup_cells(area)
    cells["area"] = a.area
    print(f"area {a.area}: {len(cells['cell']):,} land cells, "
          f"{cells['box'][1]} × {cells['box'][3]} points an hour")

    if not a.write_only:
        start, end = np.datetime64(a.start), np.datetime64(a.end)
        todo = []
        for y in wg.YEARS:
            for per in range(wg.NPERIODS):
                d = period_days(y, per).astype("datetime64[D]")
                if d[-1] < start or d[0] > end:
                    continue
                need = [l for l in layers if not os.path.exists(f"{CACHE}/{a.area}/{l}/{y}-{per:02d}.npz")]
                if need:
                    todo.append((y, per, need))
        print(f"{len(todo)} half-months to fetch")
        t0 = time.time()
        for k, (y, per, need) in enumerate(todo):
            t1 = time.time()
            miss = run_period(y, per, need, cells, min(a.workers, 8))
            el = time.time() - t0
            print(f"  {y} {per // 2 + 1:>2}/{'a' if per % 2 == 0 else 'b'} {','.join(need)}: "
                  f"{time.time() - t1:.0f} s{f', {miss} hours missing' if miss else ''}; "
                  f"{k + 1}/{len(todo)}, about {el / (k + 1) * (len(todo) - k - 1) / 3600:.1f} h left",
                  flush=True)

    total = sum(write_layer(l, area, cells, a.out.rstrip('/'), a.url.rstrip('/')) for l in layers)
    print(f"wrote {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
