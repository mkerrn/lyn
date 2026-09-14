#!/usr/bin/env python3
"""
Download historical lightning from MET Norway's Frost API and pack it into
the compact binary the map reads.

    export FROST_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    python3 fetch_lightning.py --from 2024-01-01 --to 2024-12-31 --out lightning.bin.gz

Get a client ID (free, e-mail address only) at https://frost.met.no/auth/requestCredentials.html

Raw UALF is cached per day under ./cache, so an interrupted run picks up where
it stopped and a second run over an overlapping period costs nothing.

Output format, LYN1, little endian, sorted by time:

    offset 0    "LYN1"
    offset 4    uint32  n            number of strikes
    offset 8    uint32  t0           unix seconds the timestamps count from
    offset 12   20 bytes reserved
    offset 32   uint32[n]  t         seconds since t0
                int32[n]   lat       degrees * 1e5
                int32[n]   lon       degrees * 1e5
                int16[n]   peak      peak current, kA, signed
                uint8[n]   smaj      semi-major axis, units of 0.1 km, clipped at 25.5
                uint8[n]   smin      semi-minor axis, same units
                uint8[n]   ang       ellipse angle, degrees 0-179
                uint8[n]   flags     bit 0: 1 = cloud to cloud, 0 = cloud to ground

18 bytes per strike. A busy Norwegian year is 150-400 k strikes: about
3-7 MB raw and a little over half that gzipped.
"""

import argparse, base64, datetime as dt, gzip, os, sys, time, urllib.error, urllib.parse, urllib.request
from array import array

FROST = "https://frost.met.no/lightning/v0.ualf"

# Norway plus its economic zone, which is what MET's own strike counts cover.
DEFAULT_BBOX = (2.0, 56.5, 33.0, 72.0)   # west, south, east, north


def polygon(bbox):
    w, s, e, n = bbox
    pts = [(w, s), (e, s), (e, n), (w, n), (w, s)]
    return "POLYGON ((" + ", ".join(f"{x} {y}" for x, y in pts) + "))"


def fetch_window(client_id, start, end, bbox, tries=4):
    """One request. Returns UALF text."""
    q = urllib.parse.urlencode({
        "referencetime": f"{start.isoformat()}Z/{end.isoformat()}Z",
        "geometry": polygon(bbox),
    })
    req = urllib.request.Request(FROST + "?" + q)
    token = base64.b64encode(f"{client_id}:".encode()).decode()
    req.add_header("Authorization", "Basic " + token)
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", "replace")[:300]
            if err.code == 404:          # Frost says 404 when a window is empty
                return ""
            if err.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise SystemExit(f"Frost returned {err.code} for {start}..{end}\n{body}")
        except urllib.error.URLError:
            if attempt < tries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    return ""


def fetch_day(client_id, day, bbox, cache):
    path = os.path.join(cache, day.isoformat() + ".ualf")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    start = dt.datetime.combine(day, dt.time(0, 0, 0))
    text = fetch_window(client_id, start, start + dt.timedelta(days=1) - dt.timedelta(milliseconds=1), bbox)
    os.makedirs(cache, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def parse_ualf(text):
    """Yield (unix_seconds, lat, lon, peak_kA, semimajor_km, semiminor_km, angle, cloud)."""
    for line in text.splitlines():
        f = line.split()
        if len(f) < 22:
            continue
        # The first field is a version number on Frost data and absent in plain
        # UALF. A year is four digits and well above any version number.
        if len(f[0]) == 4 and f[0].isdigit() and int(f[0]) > 1900:
            pass
        else:
            f = f[1:]
        if len(f) < 21:
            continue
        try:
            y, mo, d, h, mi, s = (int(f[i]) for i in range(6))
            nano = int(f[6])
            lat, lon = float(f[7]), float(f[8])
            peak = int(float(f[9]))
            ang = float(f[13])
            smaj, smin = float(f[14]), float(f[15])
            cloud = int(f[20])
        except (ValueError, IndexError):
            continue
        try:
            ts = dt.datetime(y, mo, d, h, mi, min(s, 59), tzinfo=dt.timezone.utc).timestamp()
        except ValueError:
            continue
        yield (ts + nano / 1e9, lat, lon, peak, smaj, smin, ang, cloud)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def write_lyn1(rows, out):
    rows.sort(key=lambda r: r[0])
    n = len(rows)
    if n == 0:
        raise SystemExit("No strikes to write.")
    t0 = int(rows[0][0])

    t = array("I"); lat = array("i"); lon = array("i")
    peak = array("h"); smaj = array("B"); smin = array("B")
    ang = array("B"); flags = array("B")

    for ts, la, lo, pk, sj, sn, an, cl in rows:
        t.append(int(ts - t0))
        lat.append(int(round(clamp(la, -90, 90) * 1e5)))
        lon.append(int(round(clamp(lo, -180, 180) * 1e5)))
        peak.append(int(clamp(pk, -32000, 32000)))
        smaj.append(int(clamp(round(sj * 10), 0, 255)))
        smin.append(int(clamp(round(sn * 10), 0, 255)))
        ang.append(int(round(an)) % 180)
        flags.append(1 if cl else 0)

    if sys.byteorder != "little":
        for a in (t, lat, lon, peak):
            a.byteswap()

    header = bytearray(32)
    header[0:4] = b"LYN1"
    header[4:8] = n.to_bytes(4, "little")
    header[8:12] = t0.to_bytes(4, "little")

    blob = bytes(header) + b"".join(a.tobytes() for a in (t, lat, lon, peak, smaj, smin, ang, flags))
    if out.endswith(".gz"):
        with gzip.open(out, "wb", compresslevel=9) as f:
            f.write(blob)
    else:
        with open(out, "wb") as f:
            f.write(blob)

    size = os.path.getsize(out)
    span = (dt.datetime.fromtimestamp(t0 + t[0], dt.timezone.utc).date(),
            dt.datetime.fromtimestamp(t0 + t[-1], dt.timezone.utc).date())
    cc = sum(flags)
    print(f"{n:,} strikes  {span[0]} to {span[1]}  "
          f"({n-cc:,} cloud to ground, {cc:,} cloud to cloud)")
    print(f"wrote {out}  {size/1e6:.1f} MB")


def demo(n, out):
    """Synthetic strikes so the map can be tried before you have a client ID."""
    import math, random
    random.seed(7)
    rows = []
    base = dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc).timestamp()
    # A handful of wandering storm cells, each firing a burst of strikes.
    for _ in range(max(1, n // 400)):
        clat = random.uniform(58.0, 70.0)
        clon = random.uniform(5.0, 28.0)
        t = base + random.uniform(0, 365 * 86400)
        for _ in range(random.randint(100, 700)):
            t += random.expovariate(1 / 4.0)
            clat += random.gauss(0, 0.004); clon += random.gauss(0, 0.010)
            la = clat + random.gauss(0, 0.05)
            lo = clon + random.gauss(0, 0.10)
            cloud = 1 if random.random() < 0.35 else 0
            pk = random.gauss(0, 28) if cloud else random.gauss(-22, 30)
            sj = abs(random.gauss(0.4, 0.5)) + 0.1
            rows.append((t, la, lo, int(pk), sj, sj * random.uniform(0.3, 0.9),
                         random.uniform(0, 180), cloud))
            if len(rows) >= n:
                break
        if len(rows) >= n:
            break
    write_lyn1(rows, out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="start", help="first day, YYYY-MM-DD")
    p.add_argument("--to", dest="end", help="last day, YYYY-MM-DD, inclusive")
    p.add_argument("--out", default="lightning.bin.gz", help="output file; .gz compresses it")
    p.add_argument("--client-id", default=os.environ.get("FROST_CLIENT_ID"))
    p.add_argument("--cache", default="cache", help="where raw UALF days are kept")
    p.add_argument("--bbox", help="west,south,east,north in degrees")
    p.add_argument("--min-current", type=float, default=0.0,
                   help="drop strikes weaker than this many kA, to thin a long archive")
    p.add_argument("--cg-only", action="store_true", help="keep cloud to ground only")
    p.add_argument("--demo", type=int, metavar="N", help="write N fake strikes instead of calling Frost")
    a = p.parse_args()

    if a.demo:
        demo(a.demo, a.out)
        return

    if not (a.start and a.end):
        p.error("--from and --to are required (or use --demo)")
    if not a.client_id:
        p.error("set FROST_CLIENT_ID or pass --client-id")

    bbox = tuple(float(x) for x in a.bbox.split(",")) if a.bbox else DEFAULT_BBOX
    d0 = dt.date.fromisoformat(a.start)
    d1 = dt.date.fromisoformat(a.end)
    days = (d1 - d0).days + 1

    rows = []
    for i in range(days):
        day = d0 + dt.timedelta(days=i)
        text = fetch_day(a.client_id, day, bbox, a.cache)
        got = 0
        for r in parse_ualf(text):
            if a.cg_only and r[7]:
                continue
            if abs(r[3]) < a.min_current:
                continue
            rows.append(r)
            got += 1
        print(f"\r{day}  {got:>6,} kept  {len(rows):>9,} total", end="", flush=True)
    print()
    write_lyn1(rows, a.out)


if __name__ == "__main__":
    main()
