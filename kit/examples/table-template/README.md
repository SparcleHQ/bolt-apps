# table-template

## What this teaches
The `table` pane: columns with `label`, `align`, `format` (text, number, percent, currency, date), `unit`, per-column `total` (sum, avg, min, max, count), `sort` and `totals_label`. A share column stands in for a pie chart, which the launcher cannot draw. `app.searchable` is accepted and does nothing: once the app has rows, Bolt filters them as you type (title and subtitle).

## Copy this to build
Any list that needs sorting and totals: orders, invoices, usage, inventory.

## Edit only these fields
`scripts/table-template__config.json`: `endpoints`, `views[].item.extra` (one field per column; numbers stay numbers when the value is exactly `{field}`), `widget.bind.columns`. `scripts/table-template__fixtures.json`. Details: `../ENGINE.md`.

## Behaviour
A table shows every row, so the data view has no Back or refresh rows. The pane can draw 500 rows, but the engine hands a view at most 50 (`MAX_ROWS` in `engine.py`), and the view says "showing the first 50". A stale or partial notice appears as one extra row only when the data could not be refreshed.

## Commands
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.
```
./bolt-apps kit vendor --flat kit/examples/table-template
./bolt-apps regen kit/examples/table-template
./bolt-apps check kit/examples/table-template --update-golden
./bolt-apps lint kit/examples/table-template --personal
./bolt-apps pack kit/examples/table-template --personal --version 1.0.1 --out table-template-1.0.1.boltpack
```
