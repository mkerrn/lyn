# Plan: Weather history layers

Turn the lightning map into **Weather history**: one map, one layer at a time,
picked from a *Layer* selector. Lightning stays as it is. The new layers are
gridded averages over **2016–2025**, the same years as the lightning, so the
year buttons mean the same thing on every layer. Norway first, then the Nordic
countries, then Europe.

Written for the sessions that implement it. Work through the sessions in
order, tick the boxes as you go, and commit the ticked plan with the work
(CLAUDE.md: commit and push to `origin main` once a change is checked). If a
decision here turns out wrong when you meet the real data, change the plan in
the same commit and say why in a line under *Changes to the plan* at the bottom.

## Layers

| Layer | Bands (stored per half-month, per year) | How it is made |
|---|---|---|
| Lightning | — | as today |
| Thunderstorm days | days with a strike within 10 km | from `data/lightning-*.bin.gz` |
| Temperature | day = mean daily max, night = mean daily min | hourly 2 m temperature |
| Feels like | day = mean daily max, night = mean daily min of hourly apparent temperature | wind chill below 10 °C, Steadman apparent temperature (T, RH, wind) above |
| Wind | mean daily max of hourly 10 m wind | MET Nordic has no gusts; say so in the panel |
| Humidity | mean relative humidity, and mean over daylight hours | hourly RH |
| Rain | mm, days ≥ 1 mm, days ≥ 10 mm | hourly precipitation × liquid fraction |
| Snow | mm water equivalent, days ≥ 1 mm | hourly precipitation × snow fraction: all snow ≤ 0 °C, all rain ≥ 2 °C, linear between. Note ≈ 1 cm fresh snow per mm |
| Sun (sky) | sun hours per day, days with ≥ 1 h / ≥ 3 h / ≥ 6 h sun | sunshine estimated from shortwave radiation, see *Sun* below |
| Sun seen from the ground | expected days the sun was seen at a random point in the cell (≥ 15 min / ≥ 1 h / ≥ 3 h), and expected hours of direct sun there | sky sunshine × terrain horizon, see *Sun* below |
| UV | mean daily max UV index (estimate) | see session 5 |
| Bugs | modelled mosquito/midge activity index | see session 5; clearly labelled a model |

Day and night are daily max and daily min. Days are counted in local solar
time, UTC + longitude/15, everywhere, so the same rule works across Europe.

## How the filters apply to a grid layer

- **Years**: the average over the selected years.
- **Months / days of the year**: which half-months take part. A day range
  includes each half-month weighted by how many of its days are in the range.
- Each band says how it combines:
  - `mean` bands (temperatures, wind, humidity, UV, bugs, sun hours per day)
    are averaged over the selected half-months, weighted by days.
  - `sum` bands (days with X, mm) are added up over the selected half-months
    and shown **per year in the selected part of the year**. Example: with
    Jun–Aug ticked, rain days means days of rain per summer.
- Lightning-only filters (type, current, draw mode, ellipses, density grid,
  open a file) don't apply to grid layers and are hidden when one is shown.
- **Region tool**: for a grid layer, the area-weighted mean (or sum) over the
  land cells inside the outline, charted by part of the year with the existing
  `seasonBins` / `barChart` in `region.js`. There is no hour-of-day chart for
  grid layers; hide the *Hours in* selector there.
  For *Sun seen from the ground* this answers the user's question directly.
  Every cell already holds the expectation over random points inside it, so
  the land-area-weighted mean over the region is the expected number of days
  the sun is seen from a random point in the region.

## The grid

Store every grid layer on the **web-mercator cell grid the density pyramid
already uses** (`strikes.js`, world coordinates `D.wx` / `D.wy`):

- Norway and the Nordics at level 13, about 2.1 km at 65°N.
- Europe from ERA5-Land at level 11 or 12.

Cells stay fixed to the map, drawing a level is a straight copy into a
canvas, and the region tool and the strike grid line up with it. Ocean cells
are nodata. Lakes count as land.

### File format `WXG1`

Little endian, gzipped. Reuse `gunzip` / `maybeGunzip` from `data.js`.

```
magic 'WXG1' | uint16 version | uint8 level L | uint8 nbands | uint8 nperiods (24)
int16 year (0 = mean of all years) | uint32 x0, y0 (cell coords at level L) | uint16 nx, ny
per band: char[16] id | uint8 dtype (1 = uint8, 2 = int16, 3 = uint16) | float32 scale, offset | uint16 nodata
data: band-major, then period (24 half-months: 1–15 and 16–end of each month), then row-major nx × ny
```

value = raw × scale + offset. Use uint8 wherever the resolution allows:

- day counts: there are at most 16 days per half-month
- temperatures: 0.5 °C steps, offset −60
- RH: 1 %

Keep int16 / uint16 for mm.

One file per **layer × area × year**, plus one with year 0 holding the mean
over all ten years, so the default view (all years on) downloads one file.
The index is `data/wx/index.json`:

```json
{ "format": "WXG1", "years": [2016, ..., 2025],
  "areas": [{"id": "no", "L": 13, "x0": ..., "y0": ..., "nx": ..., "ny": ...}],
  "layers": [{"id": "temp", "label": "Temperature", "source": "MET Nordic",
              "bands": [{"id": "tmax", "label": "Day", "unit": "°C", "agg": "mean", "ramp": "temp"}, ...],
              "files": {"no": {"0": "data/wx/temp-no-mean.bin.gz", "2016": "data/wx/temp-no-2016.bin.gz", ...}}}] }
```

Adding the Nordics or Europe later only means adding areas and files.

### Size and hosting

At level 13, Norway is about 75 000 land cells. One uint8 band is about
1.8 MB per year before gzip.

All the layers come to roughly 15–25 MB per year after gzip for Norway, four
times that for the Nordics. `.git` is already 222 MB.

**After session 2 generates Norway, measure.** If the grid data for all ten
years is heading past ~150 MB, stop and ask the user. The alternatives are:

- a separate data repo served from GitHub Pages
- per-year files only for some layers
- a coarser level

Don't silently commit hundreds of MB.

## Data sources

- **MET Nordic analysis** (MET Norway), 1 km, hourly, Norway, Sweden,
  Finland, Denmark and the Baltics. Docs:
  https://github.com/metno/NWPdocs/wiki/MET-Nordic-dataset
  - Rerun archive v4, `metpparchivev4/YYYY/MM/DD/`, runs 2012-09 to
    2025-10-31.
  - Operational archive, `metpparchive/`, runs from 2018-03. Use it for
    Nov–Dec 2025.
  - Base URLs: `https://thredds.met.no/thredds/dodsC/` for OPeNDAP,
    `.../fileServer/` for whole files.
  - Variables: `air_temperature_2m`, `relative_humidity_2m`,
    `wind_speed_10m`, `precipitation_amount` (the hour before),
    `cloud_area_fraction`,
    `integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time`,
    `altitude`, `land_area_fraction`.
  - Projection: LCC `+proj=lcc +lat_0=63 +lon_0=15 +lat_1=63 +lat_2=63 +R=6.371e+06`.
  - Credit "© Meteorologisk institutt" in the panel and the attribution
    control, like the lightning.
- **ERA5-Land** (Copernicus CDS, free account, `cdsapi`), about 9 km,
  hourly, worldwide. For Europe in session 4. It has 2 m temperature and
  dew point, 10 m u/v wind, total precipitation, snowfall and surface solar
  radiation downwards, but no cloud cover.
- **Frost** (the client ID the user already has) for station sunshine
  duration, to calibrate the sunshine estimate. Check the element name in the
  Frost element list; it is something like `sum(duration_of_sunshine PT1H)`.
- **Terrarium elevation tiles**, as already used by `altitude.js`, for the
  terrain horizons.

## Sun

**Sky sunshine per hour.** MET Nordic has no sunshine duration, so estimate it
from radiation:

1. Take G = the hourly shortwave integral / 3600 s.
2. Take G_cs = a clear-sky model, e.g. Haurwitz, 1098·cosZ·exp(−0.057/cosZ),
   with Z the zenith angle at mid-hour. Correct it lightly for altitude.
3. With k = G / G_cs, the sunshine fraction of the hour is
   s = clamp((k − k0)/(k1 − k0), 0, 1). Start with k0 = 0.4, k1 = 0.75, and
   s = 0 below 3° sun elevation.
4. Fit k0 and k1 to Frost hourly sunshine at several stations spread across
   the country. Write the fit and the stations in this file.
   `cloud_area_fraction` is the fallback if radiation turns out noisy.

Sky sun hours = Σ s over the day.

**Sun seen from the ground.** This is the user's question: if I was at a
random point here, on how many days would I have seen the sun? It needs the
terrain as well as the sky. Mountains block low sun, valleys sit in shadow for
weeks in winter, and polar night falls out of it with no special case.

1. **Sample points.** Take 16 stratified-jittered points per cell (4 × 4),
   on land.
2. **Horizons.** For each point, compute the horizon angle at 64 azimuths.
   - March outward to 40 km, with steps growing with distance, over a
     terrarium DEM mosaic at z10 (about 60 m at 65°N; use z9 if memory is
     short).
   - Correct for the earth's curvature and refraction: drop = d² / (2R) × 0.87.
   - Cache the horizons under `cache/horizons/` and write the code with
     numba or vectorised numpy.
3. **In the hourly pass over MET Nordic**, for each hour:
   - compute the sun's azimuth and elevation once per cell, at 4 sub-steps
     of 15 min
   - v(p, h) = the fraction of sub-steps where the sun is above point p's
     horizon at that azimuth
   - add 60 · s(cell, h) · v(p, h) minutes to point p's running total for the day.
4. **At the end of each local day**, threshold each point's total at
   15 min, 1 h and 3 h. Add the fraction of the cell's points that pass to
   the cell's day counts. Add the mean minutes to the ground sun hours.

Treat cloud gaps and terrain as independent within the hour. Say in the panel
that this is an expectation over points, not a guarantee for any one spot.
The radiation field is from a ~2.5 km model, so its own terrain shading is
negligible and there is no double counting.

This runs inside the same hourly pass as everything else, so it needs no
hourly storage: about 1.2 M points × one float for the day's minutes.

## Sessions

Yes, split it. Each session ends with something working, committed and
pushed.

### Session 1 — layer switch, grid renderer, thunderstorm days

No new downloads.

- [x] Rename to **Weather history**: `<title>`, panel `<h1>`, README heading
      and intro. Keep the `lyn.*` localStorage keys so saved colours survive.
- [x] *Layer* section at the top of the panel: a `<select id="layer">`, kept
      in localStorage. Give lightning-only sections a class (e.g.
      `data-layers="lightning"`). One function shows and hides sections from
      the current layer. Grid layers get one shared section with:
      - a band select (Day / Night, thresholds, …)
      - a colour ramp legend, with a *fix the scale* option like Altitude's
      - opacity
      - source and attribution notes.
- [x] `js/grid.js`: load `data/wx/index.json`, then fetch layer/area/year
      files on demand. Use the mean file when every year is on, and cache what
      has been loaded. Parse `WXG1`. Combine years and half-months into one
      Float32Array per area for the current band and filters. Redo this only
      when the filters change, using a `filterGen`-style counter. Draw the
      cells in view to a canvas layer, reusing the pattern in `strikes.js`.
      Ramps:
      - temperature: diverging at 0 °C
      - days / mm / hours: sequential
      - keep the warm strike colours out of the ramps so they stay distinct.
- [x] The corner readout shows the value under the pointer. A click popup
      shows the value and a 24-bar chart by half-month for that cell over the
      selected years.
- [x] Region tool: for grid layers, the land-area-weighted value inside the
      outline and the by-part-of-year chart. Hide *Hours in*.
- [x] Altitude stays shared. Its *Strikes by height* button is lightning-only
      for now.
- [x] `make_thunder_days.py`: read `data/lightning-*.bin.gz` (reuse the
      parsing in `split_years.py`). For each level-13 cell and each local day,
      mark a thunderstorm day if any strike, CG or CC, is within 10 km of the
      cell centre. Write `thunder-<area>-<year>.bin.gz` plus the mean file,
      and the index. Make the area the bounding box of the lightning data,
      so it covers sea too. Thunderstorm days are the one grid layer without
      a land mask. Note in the panel that detection drops far offshore.
- [x] README: the layer list, the new files, the `WXG1` format, and how to
      rebuild. CLAUDE.md: add `grid.js` globals to *Finding your way*.

### Session 2 — MET Nordic pipeline for Norway, and the non-sun layers

- [ ] **Probe first.** Time and size one hour of the needed variables for the
      Norway box, by OPeNDAP with a stride of 2 (2 km, as the level-13 grid)
      and by NCSS if THREDDS offers it for this archive, with compressed
      NetCDF4 output.
      - Hourly over ten years is 87 600 requests. At stride 2 the uncompressed
        OPeNDAP volume for six variables is roughly 1 TB.
      - If the full pull would take more than about a day, stop and ask the
        user. Options: NCSS compressed, a coarser stride, seNorge daily 1 km
        for temperature and precipitation with fewer hours for the rest, or
        ERA5-Land.
      - Write what you measured here.
- [ ] `fetch_climate.py`:
      - Download hour by hour and resample LCC to the level-13 cells. Nearest,
        or the mean of the 1 km points inside each cell.
      - Accumulate the daily stats in memory and discard the raw hours.
      - Cache the finished days under `cache/wx/`, so a stopped run resumes
        at the next missing day, like `fetch_lightning.py`.
      - Then reduce the days to half-months per year and write `WXG1`.
      - Run several downloads in parallel, but no more than 4–8 at once
        against thredds.met.no.
      - `--from`, `--to`, `--area`, `--layers`.
- [ ] Test on one month, check the maps against expectation (a cold
      Jotunheimen, a wet Vestland), then start the full run in the background
      or leave the user the command. It may outlive the session; the session
      can end once one full year is built and shown.
- [ ] Layers: Temperature, Feels like, Wind, Humidity, Rain, Snow, as in the
      table.
- [ ] Measure the data size and act on *Size and hosting* before committing
      the data.

### Session 3 — sun

- [ ] Sky sunshine estimate and Frost calibration, as in *Sun*.
- [ ] Horizon computation for the sample points, cached.
- [ ] Add both sun layers to the hourly pass. Rerun the pipeline: the
      finished days in `cache/wx/` only hold the earlier layers, so the sun
      layers need the hours again. Write the pass so later layers can be added
      this way without refetching more than the variables they need.
- [ ] Layers *Sun (sky)* and *Sun seen from the ground*: thresholds as band
      options, and notes on what the expectation means. Check that Tromsø
      shows polar night and that a deep valley like Rjukan has far fewer days
      seen than the plateau above it in winter.

### Session 4 — the Nordics, then Europe

- [ ] Nordics: the same pipeline over the full MET Nordic domain as new areas
      (`se`, `fi`, `dk`, or one `nordic` area). Check the size first.
- [ ] Europe: ERA5-Land through `cdsapi`, in an area at level 11 or 12.
      - Derive RH from the dew point and wind from u/v.
      - Snow comes from `snowfall` directly.
      - Sunshine uses the same clearness method from `ssrd`.
      - The CDS also has a daily-statistics ERA5-Land product. It is cheaper
        for the daily layers, but the sun layers need hourly data.
- [ ] Temperature height correction for coarse areas. Store each cell's model
      elevation as a band. In the client, correct temperature and feels-like
      by −6.5 °C/km against the DEM tiles `altitude.js` already loads. Make it
      a toggle, on by default, for ERA5-Land areas.
- [ ] Where two areas overlap, draw the finer one.

### Session 5 — UV and bugs (estimates, labelled as such)

- [ ] UV. First check whether CAMS has a usable UV-index archive for
      2016–2025. Otherwise compute an hourly UVI:
      - clear-sky UVI ≈ 12.5 · cosZ^2.42 · (Ω/300)^−1.23, with Ω the total
        ozone from a monthly climatology by latitude
      - × a cloud factor from the clearness k
      - × (1 + 0.07 per km of altitude)
      - × a snow-albedo factor where seNorge snow, or the Snow layer, says
        there is snow on the ground.
      Take the daily max.
- [ ] Bugs. An hourly activity in 0–1 = f(T) · f(wind) · f(RH) · f(light):
      - f(T): active from about 10 °C, peaking at 20–25 °C
      - f(wind): falls off between 2 and 5 m/s
      - f(RH): favours above 60 %
      - f(light): peaks at dusk and dawn
      - × a season gate (degree days above 5 °C since 1 Jan past a threshold)
      - × a habitat factor: the wetland and water fraction within about 2 km,
        from NIBIO AR50 / Kartverket N50 in Norway and CORINE in Europe.
      The daily index is the sum of activity hours. Show it as a relative
      0–10 scale, with a panel note that no measured bug data exists and this
      is a weather-and-habitat model.

## Changes to the plan

(Add a dated line here whenever a session changes the plan, and why.)

- 2026-10-27, session 1: layers in `index.json` also carry `attribution` and
  `note`, shown in the attribution control and the panel. The grid helpers
  (cells, half-months, solar days, `WXG1` writer, index update) are in
  `wxgrid.py` for `fetch_climate.py` to reuse. Sequential ramps fade to
  mostly see-through at the low end, so empty cells don't veil the base map.
