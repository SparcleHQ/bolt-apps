# chart-template

## What this teaches
Every chart the launcher can draw, each fed both ways, plus a cards-only dashboard. Facts read from the launcher's chart pane code:

| | rows mode | series mode |
|---|---|---|
| bind | `x` (label field), `y` (number field), `label` | `values` (a row field holding a number list), `label` |
| rows | one point per row, mode `list_data` | one row per series, mode `selected_row` (the selected row is plotted) |
| in this app | `trend` is the number-list field: `item.trend_field` copies a list from your data |  |

- Types here: `line` (the default), `bar`, `sparkline`, which every Bolt draws. Pie, donut, area and several lines (`bind.series`) need Bolt 0.1.182 and are in `../chart-types`. `color` is `accent` or `muted`. Hover shows values; there is nothing else interactive.
- Axes: bars are drawn from zero so height equals value; a line or sparkline spans the series minimum to maximum. A sparkline has no axes or labels. Latest and peak numbers are shown with the chart.
- A row whose y is not a number is skipped and the pane says so; it is never drawn as zero. The engine hands a view a limited number of rows (see [the rules table](../QUICKSTART.md#4-the-rules-table)), so a chart here shows no more than that.
- On a Bolt older than 182 a share can be shown with cards that use `max` and a unit as a progress meter, or a table with a percent column (see `../table-template`).
- A chart plots every row, so these views carry no Back or refresh rows; a stale or partial notice is the one extra row when data could not be refreshed.

## Copy this to build
A metrics or trends app. Start from the overview (tiles with a sparkline trend) and the view closest to your data.

## Edit only these fields
`scripts/chart-template__config.json`: `endpoints` (path, `map`), `views[].item.extra` (`label`, `value`), `views[].item.trend_field`, `widget.bind`, `overview.rows`. `scripts/chart-template__fixtures.json`: one raw response per endpoint. Details: `../ENGINE.md`.

## Commands
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.
```
./bolt-apps kit vendor --flat kit/examples/chart-template
./bolt-apps regen kit/examples/chart-template
./bolt-apps check kit/examples/chart-template --update-golden
./bolt-apps lint kit/examples/chart-template --personal
./bolt-apps pack kit/examples/chart-template --personal --version 1.0.1 --out chart-template-1.0.1.boltpack
```
Raise the version each time: Bolt refuses the same or an older one. Keep the pack outside the folder.
