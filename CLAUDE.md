# Lightning map

See README.md for what the files do and how the data is built.

## Committing and pushing

Once a change is made and checked, commit it and push it to `origin main`
straight away. No need to ask first.

- Keep commit messages short and lowercase, like the existing history.
- Never commit `cache/`, the big combined `.bin.gz`, or a Frost client ID.
  Run `git status --ignored` if in doubt.

## Finding your way

The map is split by concern so a change only needs one or two files read.
The file list in README.md says what is in each. Shared state lives in globals:
`D` (the dataset, `data.js`), `groups` / `groupTiles` / `filtered` (`filter.js`),
`map`, `CLASSES`, `classOn` (`map.js`), `strikes` (`strikes.js`). Use grep for
an element id or function name rather than reading whole files.
