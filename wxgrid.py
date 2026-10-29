"""
Shared helpers for the gridded weather layers: the web-mercator cell grid,
half-month periods, local solar days, writing WXG1 files and keeping
data/wx/index.json up to date. Used by make_thunder_days.py, and by the
climate pipeline that comes after it.
"""

import gzip, json, os, struct

import numpy as np

NPERIODS = 24          # half-months: 1–15 and 16–end of each month
DTYPES = {1: np.uint8, 2: np.int16, 3: np.uint16}
INDEX = "data/wx/index.json"
YEARS = list(range(2016, 2026))


# ---------- the cell grid ----------
# The same scheme as the density pyramid in js/strikes.js: normalised web
# mercator, 0–1 across the world, 2**L cells a side at level L.

def world_xy(lat, lon):
    s = np.sin(np.radians(lat))
    return (np.asarray(lon) + 180) / 360, 0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)


def lat_of_world_y(y):
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * np.asarray(y)))))


def area_of_bbox(west, south, east, north, L, pad_cells=0):
    """Cell range at level L covering a lon/lat box: x0, y0, nx, ny."""
    N = 2 ** L
    xa, ya = world_xy(north, west)
    xb, yb = world_xy(south, east)
    x0 = int(np.floor(xa * N)) - pad_cells
    y0 = int(np.floor(ya * N)) - pad_cells
    x1 = int(np.floor(xb * N)) + pad_cells
    y1 = int(np.floor(yb * N)) + pad_cells
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1


def cell_centres(L, x0, y0, nx, ny):
    """Latitude per row and longitude per column of the cell centres."""
    N = 2 ** L
    lat = lat_of_world_y((y0 + np.arange(ny) + 0.5) / N)
    lon = (x0 + np.arange(nx) + 0.5) / N * 360 - 180
    return lat, lon


# ---------- MET Nordic ----------
# Lambert conformal on a sphere, tangent at 63°N, centred on 15°E; 1 km
# points, row 0 at the south edge.

LCC_R, LCC_LAT, LCC_LON = 6371000.0, 63.0, 15.0
LCC_X0, LCC_Y0, LCC_NX, LCC_NY = -897442.2, -1104322.0, 1796, 2321


def lcc_index(lat, lon):
    """Lat/lon to fractional column and row of the MET Nordic grid."""
    p = np.radians(LCC_LAT)
    n = np.sin(p)
    F = np.cos(p) * np.tan(np.pi / 4 + p / 2) ** n / n
    rho0 = LCC_R * F / np.tan(np.pi / 4 + p / 2) ** n
    rho = LCC_R * F / np.tan(np.pi / 4 + np.radians(lat) / 2) ** n
    th = n * np.radians(np.asarray(lon) - LCC_LON)
    return (rho * np.sin(th) - LCC_X0) / 1000, (rho0 - rho * np.cos(th) - LCC_Y0) / 1000


# ---------- the sun ----------

def sun_elevation(t, lat, lon):
    """Solar elevation in degrees at unix seconds t (NOAA's short series)."""
    t = np.asarray(t, dtype=np.float64)
    s = t.astype("datetime64[s]")
    doy = (s - s.astype("datetime64[Y]")).astype(np.float64) / 86400
    g = 2 * np.pi / 365 * doy
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
            + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g)
                    - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    tst = (t % 86400) / 60 + eqt + 4 * np.asarray(lon)
    ha = np.radians(tst / 4 - 180)
    la = np.radians(lat)
    s = np.sin(la) * np.sin(decl) + np.cos(la) * np.cos(decl) * np.cos(ha)
    return np.degrees(np.arcsin(np.clip(s, -1, 1)))


# ---------- time ----------

def solar_days(t, lon):
    """Unix seconds to local solar days since 1970: UTC + longitude/15 h."""
    return np.floor((np.asarray(t, dtype=np.float64) + np.asarray(lon) * 240) / 86400).astype(np.int64)


def day_parts(days):
    """Days since 1970 to year, month (1–12), day of month, half-month period."""
    d = np.asarray(days).astype("datetime64[D]")
    y = d.astype("datetime64[Y]").astype(int) + 1970
    m = d.astype("datetime64[M]").astype(int) % 12 + 1
    dom = (d - d.astype("datetime64[M]")).astype(int) + 1
    return y, m, dom, 2 * (m - 1) + (dom > 15)


# ---------- WXG1 ----------

def write_wxg(path, L, x0, y0, nx, ny, year, bands):
    """bands: list of dicts with id, dtype (1/2/3), scale, offset, nodata and
    data, an array of raw values shaped (24, ny, nx)."""
    head = b"WXG1" + struct.pack("<HBBBhIIHH", 1, L, len(bands), NPERIODS, year, x0, y0, nx, ny)
    for b in bands:
        head += struct.pack("<16sBffH", b["id"].encode()[:16], b["dtype"], b["scale"], b["offset"], b["nodata"])
    body = b"".join(np.ascontiguousarray(b["data"], dtype=np.dtype(DTYPES[b["dtype"]]).newbyteorder("<"))
                    .tobytes() for b in bands)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # No time stamp in the gzip header, so rewriting unchanged data gives the
    # same bytes and adds nothing to the data repo's history.
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as f:
        f.write(head + body)
    return os.path.getsize(path)


# ---------- the index ----------

def update_index(area, layer, files):
    """Adds or replaces one area and one layer's files for it in the index,
    leaving every other layer and area alone."""
    idx = {"format": "WXG1", "years": YEARS, "areas": [], "layers": []}
    if os.path.exists(INDEX):
        with open(INDEX) as f:
            idx = json.load(f)
    idx["areas"] = [a for a in idx["areas"] if a["id"] != area["id"]] + [area]
    old = next((l for l in idx["layers"] if l["id"] == layer["id"]), None)
    layer = dict(layer, files=dict(old["files"] if old else {}, **{area["id"]: files}))
    idx["layers"] = [l if l["id"] != layer["id"] else layer for l in idx["layers"]]
    if not old:
        idx["layers"].append(layer)
    with open(INDEX, "w") as f:
        json.dump(idx, f, indent=1, ensure_ascii=False)
