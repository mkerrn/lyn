# Weather history

A Leaflet map of Norway's recent weather, 2016–2025, one layer at a time:
every lightning strike, and gridded climate layers averaged over the same
years, starting with thunderstorm days. Plain HTML, CSS and JS: no build
step, no server.

## Layers

Pick one under *Layer* at the top of the panel; the choice is remembered.

- **Lightning strikes** — every strike, as points or a density grid. Most of
  this README is about it.
- **Thunderstorm days** — days a year with a strike within 10 km, from the
  same lightning files.

The years, months and days of the year apply to every layer. On a grid layer
the years are averaged, and the months or day range pick which half-months
take part: counts and amounts are added up over them and shown per year (with
Jun–Aug ticked, thunderstorm days are days per summer), while temperatures and
the like are averaged. The lightning-only sections of the panel hide on a grid
layer. Temperature, feels like, wind, humidity, rain and snow are built by
`fetch_climate.py` (below). Their files are too big for this repository and
live in [mkerrn/lyn-data](https://github.com/mkerrn/lyn-data), served by GitHub
Pages; `data/wx/index.json` points there. The sun layers and more are planned
in `PLAN.md`.

## Files

- `index.html` — the panel markup; loads the stylesheet and scripts.
- `css/style.css` — all the styling.
- `js/` — classic scripts sharing one global scope, loaded in this order:
  - `map.js` — map and base layers, current classes, `shade`, `pct`.
  - `data.js` — LYN1 parsing, gunzip, merging years into tile order, the year list.
  - `filter.js` — `refilter()`: months or days of the year, type,
    current, legend → `groups`, `groupTiles`.
  - `strikes.js` — the canvas layer: points, ellipses, the density pyramid,
    sampling, the automatic switch between points and grid.
  - `altitude.js` — elevation tiles, terrain shading, strikes-by-height chart.
  - `region.js` — drawing a region on the map, and its hour-of-day chart.
  - `grid.js` — the grid layers: `WXG1` loading, combining years and
    half-months, the canvas layer, its readout, popup and region chart, and
    the layer switch.
  - `ui.js` — scale bar, readout, click popup, control wiring, boot.
- `fetch_lightning.py` — downloads UALF lightning from MET Norway's Frost API
  and packs it into one `.bin.gz`.
- `split_years.py` — cuts that file into one per year under `data/`, with an
  `index.json` the map reads to build its year list.
- `make_thunder_days.py` — the thunderstorm-days layer from the per-year
  lightning files, written to `data/wx/`.
- `fetch_climate.py` — the temperature, feels-like, wind, humidity, rain and
  snow layers from the MET Nordic analysis, written to `data/wx/`.
- `wxgrid.py` — shared helpers for the grid layers: the cell grid, half-months,
  local solar days, the MET Nordic projection, the sun's elevation, writing
  `WXG1` and updating `data/wx/index.json`.

The map reads `data/index.json`, shows a button per year with every year on,
and downloads each year the first time it is switched on. Press and drag
across the year buttons to switch several on or off at once.

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

Date range, months or days of the year, discharge type, peak current range in kA, polarity, and the
legend classes, which toggle on click. All of them compose.

The month toggles cut across the date range rather than narrowing it: leave the
range at the full archive, tick June and July only, and you get ten summers
stacked on one map. Jun–Aug and Nov–Feb presets are there because Norway has two
different lightning seasons — inland convection in late summer, and showers over
the warm sea along the coast in autumn and winter.

For a span that does not line up with whole months, type a day range such as
15/8 – 15/9 under *Days of the year*. It applies to every year in the date range
and replaces the month toggles while both ends are filled in; a span past New
Year wraps round. Dates are UTC.

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

## Base map

Kartverket's topo tiles stop at the border: outside Norway they are fully
transparent. The detection network reaches well into Sweden and Finland, so the
Kartverket base is drawn on top of OpenTopoMap, which fills in the neighbouring
countries. The other option is OpenTopoMap on its own, for one consistent style
across the whole area.

## Looking for patterns

Two tools for the question "where does it strike most", neither of which can be
answered by looking at dots:

**Density grid.** Counts per km² in cells of about 1–66 km, log-scaled,
rescaling to the strongest cell in view, or to the strongest anywhere with
*Same colour scale everywhere* ticked. It counts every strike in the filter,
never the drawn sample. Cells smaller than a pixel are widened until they are
not, and the panel says so.

The grid is fixed to the map: power-of-two cells in web mercator, the same
scheme as map tiles, so a cell does not move when you pan. Every filtered strike
is counted once into the finest level, about 1 km, when the filter changes, and
each coarser level adds up 2×2 cells of the one below. A redraw only reads the
cells in view. The sizes in the menu are at 65°N; mercator cells shrink toward
the pole, so a cell is about a quarter wider at Lindesnes and a quarter narrower
in Finnmark. Each row's true area is used for the per-km² figures.

**Strikes by height.** Turn the altitude layer on, let the tiles load, press the
button. It bins every elevation pixel on screen to get land area per 100 m band,
bins the strikes the same way, and plots strikes per 1000 km² against height. A
rising curve means altitude matters; a flat one means the effect is below the
noise. Remember that MET's position error is a few hundred metres to a couple of
kilometres, so this can show a regional trend but not a summit-versus-valley one.

**Time of day in a region.** Draw a rectangle or a freehand outline on the
map and the panel charts the strikes inside it by hour of day, using every
strike that passes the filters. Hours can be Norwegian clock time (with summer
time), local solar time (shifted by each strike's longitude), or UTC. Combine it
with the months or a day range to compare, say, late-summer inland convection
against autumn showers on the coast.

## Points or grid

*Show* is automatic by default: points while there are no more strikes on screen
than the cap, the density grid beyond it. Zoomed out over the country you get
the grid; zoom into a region and the points appear. Pick *points* or *density
grid* to hold one or the other.

## Sampling

The panel has a cap on how many strikes are drawn — 400 000 by default — and it
counts only what is on screen. Zoom into one valley and every strike there is
drawn, whatever the date range; zoom out over the whole country and the map
draws an even sample instead and says what fraction you are looking at, both in
the panel and in the corner readout: *showing a 12 % sample*.

A strike is kept when a hash of its index falls under that fraction. That
spreads the sample across the whole period and the whole view, thins each
current class by the same fraction so the legend's proportions still hold, and
is stable: a strike drawn at one zoom is still drawn when you zoom in. The
density grid and the strikes-by-height chart ignore the cap and use every
strike in the filter.

Ellipses are thinned further, to 60 000, because a rotated ellipse costs many
times what a dot does. The panel says when that is happening.

## Speed

When years are merged the strikes are sorted by map tile, about 4 km across, so
the strikes in a tile have neighbouring indices. `refilter()` keeps that order
in each class list and records where each tile starts (`groupTiles`). A draw
then reads only the rows of tiles in view: zoomed into a valley it touches a few
thousand strikes, not millions. The same tile counts decide, without reading a
strike, whether the automatic mode shows points or the grid.

Past 30 000 dots the points are written straight into a pixel buffer instead of
being drawn as canvas arcs. Every strike of all ten years, drawn as points over
the whole country, takes about a third of a second that way.

A decade of Norwegian lightning is a few million strikes. That is fine to hold
in memory — 18 bytes each plus the projection — but it is 30–50 MB compressed
and slow over a phone connection. If it feels heavy, either pack one file per
year and add a year picker, or thin at pack time with `--min-current`.

## Grid layers

Every grid layer sits on the density grid's own web-mercator cells, at level 13:
about 2 km at 65°N, fixed to the map, so a layer lines up with the strikes and
with the region tool. The files live in `data/wx/`:

- `index.json` — the years, the areas (cell range per area), and per layer its
  bands and files.
- `<layer>-<area>-<year>.bin.gz` — one per year.
- `<layer>-<area>-mean.bin.gz` — the mean over all the years, which is all the
  map downloads while every year is on.

Thunderstorm days, rebuilt from the lightning in `data/`:

```
python3 make_thunder_days.py
```

Takes about two minutes. A cell gets a day when any strike, cloud-to-ground or
cloud-to-cloud, lands within 10 km of its centre during one local solar day
(UTC + longitude/15 h). The area is the box round all the lightning, sea
included, so this is the one grid layer without a land mask; detection drops
far offshore. It writes 3–4 MB in all.

Temperature, feels like, wind, humidity, rain and snow, from the MET Nordic
analysis (hourly, 1 km) on thredds.met.no:

```
python3 fetch_climate.py                                   # 2016–2025, about 9 hours
python3 fetch_climate.py --from 2019-01-01 --to 2019-01-31 --layers temp,rain
python3 fetch_climate.py --write-only                      # rewrite the files from the cache
```

The files go to `../lyn-data/wx/`, a clone of the data repository next to this
one, and the index gets their GitHub Pages URLs; commit and push both repos.
To try a build locally first, use `--out data/wx --url data/wx`, and don't
commit those files here.

It reads every second point of the analysis by OPeNDAP, about the cell size,
and gives each land cell the point nearest its centre (land is where the
analysis counts at least half land; lakes are land). Days run in local solar
time. The hours are turned into daily stats and the days into half-month sums,
kept in `cache/wx/<area>/<layer>/` so a stopped run picks up where it was; the
raw hours are never stored. The area is the one the thunderstorm days made,
so run `make_thunder_days.py` first. Six downloads are in flight at once;
thredds.met.no allows no more than 4–8.

- Temperature: day and night are the mean daily highest and lowest.
- Feels like: wind chill below 10 °C, Steadman's apparent temperature above.
- Wind: the mean of each day's strongest hourly wind at 10 m; there are no gusts.
- Humidity: over the whole day and over the hours the sun is up.
- Rain and snow: hourly precipitation split by temperature, all snow at 0 °C
  and below, all rain at 2 °C and above. Amounts in mm (snow in mm of water,
  about 1 cm of fresh snow each), and days with at least 1 or 10 mm.

### The `WXG1` format

Little endian, gzipped.

```
magic 'WXG1' | uint16 version | uint8 level L | uint8 nbands | uint8 nperiods (24)
int16 year (0 = mean of all years) | uint32 x0, y0 (cell coords at level L) | uint16 nx, ny
per band: char[16] id | uint8 dtype (1 = uint8, 2 = int16, 3 = uint16) | float32 scale, offset | uint16 nodata
data: band-major, then period (24 half-months: 1–15 and 16–end of each month), then rows north to south, nx cells each
```

A value is raw × scale + offset; raw = nodata means no data (sea, for the
land layers). Cell (x, y) of the file is cell (x0 + x, y0 + y) of the world at
level L, the same numbering as map tiles. The header is 23 bytes plus 27 per
band, so the data starts at an odd offset; the browser copies the wider types
out to an aligned buffer.

Each layer in `index.json` has `id`, `label`, `source`, `attribution`, `note`
(shown in the panel), its `bands` (`id`, `label`, `unit`, `agg` — `sum` for
counts and amounts, `mean` for the rest — and `ramp`), and `files`, by area
then year, `"0"` being the mean file.
