# Lightning map

A single-file Leaflet map of historical lightning strikes over Norway. Same
shape as the slope map: one HTML file, no build step, no server.

## Files

- `index.html` — the map.
- `fetch_lightning.py` — downloads UALF lightning from MET Norway's Frost API
  and packs it into one `.bin.gz`.
- `split_years.py` — cuts that file into one per year under `data/`, with an
  `index.json` the map reads to build its year list.

The map never loads the whole archive. It reads `data/index.json`, shows a
checkbox per year, and downloads a year the first time you tick it.

## Try it before you have data

```
python3 fetch_lightning.py --demo 200000 --out demo.bin.gz
```

Fake strikes in fake storm cells, to see the rendering. Load it with the file
picker at the bottom of the panel. Serve the folder:

```
python3 -m http.server 8000
```

and open http://localhost:8000/. Opening `index.html` straight off the
disk also works — the browser will refuse to fetch the data file over `file://`,
but the file picker at the bottom of the panel loads it by hand.

## Real data

Get a Frost client ID (free, e-mail address only):
https://frost.met.no/auth/requestCredentials.html

```
export FROST_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
python3 fetch_lightning.py --from 2024-01-01 --to 2024-12-31 --out lightning.bin.gz
```

One request per day, cached under `cache/`, so an interrupted run resumes and a
rerun over the same dates costs nothing. A full year takes a while to pull the
first time.

Useful flags:

- `--bbox west,south,east,north` — default is Norway plus the economic zone.
- `--cg-only` — cloud-to-ground only, drops roughly a third of the records.
- `--min-current 5` — drops the weakest strikes, which is the cheapest way to
  thin a decade down to something a phone will draw.

The data is MET Norway's, under NLOD / CC BY 4.0. Keep the attribution in the
map, and don't commit your client ID.

## Publishing

```
python3 split_years.py 2016_to_2025.bin.gz --outdir data
```

Commit `index.html` and everything in `data/` — the per-year `.bin.gz` files are
the site's data and the page is empty without them. What stays out of the repo is
the big combined file and `cache/`; see the included `.gitignore`, and be careful
with a blanket `*.bin.gz` pattern, which catches the per-year files too.

Check with `git status --ignored` before pushing, or `git check-ignore -v
data/lightning-2024.bin.gz` to see which rule is excluding something. GitHub refuses files over 100 MB
outright and warns above 50 MB, and a visitor should never download a decade to
look at one summer anyway.

Git keeps every version of every file forever, so repack rarely. If you end up
regenerating often, keep the data in its own repo or attach it to a release
instead.

## The binary format

`LYN1`, little endian, sorted by time. Header of 32 bytes, then eight parallel
arrays: `uint32` seconds since the header's epoch, `int32` latitude and
longitude as degrees × 1e5, `int16` peak current in kA, `uint8` semi-major and
semi-minor axes in units of 0.1 km, `uint8` ellipse angle in degrees, `uint8`
flags with bit 0 set for cloud-to-cloud. 18 bytes per strike.

Columnar rather than one record after another, because it gzips better and
because the browser can then point a typed array straight at each column with no
parsing at all. Sorted by time so the date filter is a binary search for a slice
instead of a scan over everything.

## Filters

Date range, months, discharge type, peak current range in kA, polarity, and the
legend classes, which toggle on click. All of them compose.

The month toggles cut across the date range rather than narrowing it: leave the
range at the full archive, tick June and July only, and you get ten summers
stacked on one map. Jun–Aug and Nov–Feb presets are there because Norway has two
different lightning seasons — inland convection in late summer, and showers over
the warm sea along the coast in autumn and winter.

There is also an altitude layer, off by default, built from the same open
elevation tiles the ski map uses for slope. By default the ramp stretches to
whatever is on screen — lowest ground in view dark blue, highest pale mint — and
restretches as you pan, which means a colour does not mean the same height in
two different views. Tick "Fix the scale" and give it a range in metres to
compare places. Sea is left transparent. The ramp is blue through green so the
warm strike colours stay legible on top, and there is a brightness slider for the
strikes themselves when the contrast still is not right.

One thing the current filter cannot do is tell you which strikes were dangerous.
See the note in the panel: peak current is an estimate, and every cloud-to-ground
stroke is far past any human injury threshold. For "would this have hurt someone
standing there", the filter is *cloud to ground*, with no current limit at all.

## Looking for patterns

Two tools for the question "where does it strike most", neither of which can be
answered by looking at dots:

**Density grid.** Counts per km² in cells of 1–50 km, log-scaled, rescaling to
the strongest cell in view. If the points are sampled, counts are divided back
up to estimate the full total.

**Strikes by height.** Turn the altitude layer on, let the tiles load, press the
button. It bins every elevation pixel on screen to get land area per 100 m band,
bins the strikes the same way, and plots strikes per 1000 km² against height. A
rising curve means altitude matters; a flat one means the effect is below the
noise. Remember that MET's position error is a few hundred metres to a couple of
kilometres, so this can show a regional trend but not a summit-versus-valley one.

## Sampling

The panel has a cap on how many strikes are drawn — 150 000 by default. Past
that the map draws an even sample instead and says what fraction you are
looking at, both in the panel and in the corner readout: *showing a 12 % sample*.

The sample is every n-th record in time order, not the first n, so it is spread
across the whole period and the whole map, and each current class is thinned by
the same fraction so the legend's proportions still hold. Narrow the dates and
the sampling switches itself off.

Ellipses are thinned further, to 60 000, because a rotated ellipse costs many
times what a dot does. The panel says when that is happening.

A decade of Norwegian lightning is a few million strikes. That is fine to hold
in memory — 18 bytes each plus the projection — but it is 30–50 MB compressed
and slow over a phone connection. If it feels heavy, either pack one file per
year and add a year picker, or thin at pack time with `--min-current`.
