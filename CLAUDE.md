# Weather history

See README.md for what the files do and how the data is built.

## Committing and pushing

Once a change is made and checked, commit it and push it to `origin main`
straight away. No need to ask first.

- Keep commit messages short and lowercase, like the existing history.
- Never commit `cache/`, the big combined `.bin.gz`, or a Frost client ID.
- The climate layer files are not committed here: they go to the data repo
  `mkerrn/weatherdata`, cloned at `../weatherdata`, and are pushed from there.
  Only `data/wx/index.json` (which points at them) is committed here.
  Run `git status --ignored` if in doubt.

## Finding your way

The map is split by concern so a change only needs one or two files read.
The file list in README.md says what is in each. Shared state lives in globals:
`D` (the dataset, `data.js`), `groups` / `groupTiles` / `filtered` (`filter.js`),
`map`, `CLASSES`, `classOn`, `layerId` / `isLightning()` (`map.js`), `strikes`
(`strikes.js`), and for the grid layers `wx` (the index), `wxLayer`, `wxCur`
(what is drawn: band, years, half-month weights, per-area values) and
`wxCanvas` (`grid.js`), and the height band `hband` / `inHband()` with the
heights `elevGrids` (`altitude.js`). Panel parts for some layers only carry
`data-layers`: layer ids, `grid` meaning any grid layer. Use grep for an element id or function name rather than reading
whole files.

## Ongoing work

The map is being extended into "Weather history" with climate layers. The plan,
split into sessions with checkboxes, is in `PLAN.md`. Pick up the first session
with unticked boxes, and tick them in the same commit as the work.
