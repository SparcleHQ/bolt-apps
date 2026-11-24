# chart-types

## What this teaches
The chart types and panes Bolt 0.1.182 added, each drawn from rows: a pie, a donut, two lines (`bind.series`), an area, a heatmap and a gauge. Chart rows are plain list rows; the picture is the right pane. For line, bar and sparkline see `../chart-template`.

**Needs Bolt 0.1.184 or newer.** A Bolt 181 refuses the whole pack that uses any of these, so `bolt-app.json` sets `min_bolt_version` 0.1.184 and `./bolt-apps lint` fails without it.

| View | Pane | Bind keys used |
|---|---|---|
| `pie_rows`, `donut_rows` | `chart`, mode `list_data` | `type` (`pie` or `donut`), `x` (label field), `y` (number field), `label` |
| `multi_rows`, `area_rows` | `chart`, mode `list_data` | `type` (`line` or `area`), `x`, `label`, `series`: up to 4 entries, each `y` (or `values`) and a `label` |
| `heat_rows` | `heatmap`, mode `list_data` | `x`, `y`, `value`, `label`, `unit` (also `rows`, `cols`, `col_labels`, `layout`) |
| `gauge_row` | `gauge`, mode `selected_row` | `value` (required), `min`, `max`, `label`, `unit`, `shape` (`ring` or `half`), `thresholds` (up to 8 of `at`, `label`, `tone`) |

- Bolt 184 adds three things the overview and the area view use. The overview is a `stack` pane: a tile strip, a bar chart and a table, each drawn from its own set of the one script run (`set: tiles`, `trend`, `services`). The overview runs a named row set: its three tile rows carry `set: tiles` (config `extra`), its link rows carry none, and the pane binds `from: {set: tiles}`. The tile rows are not list rows, so the list shows only the links. The area view writes its numbers with `format: compact`, `digits: 1`, `locale: de-DE`. Both need `min_bolt_version` 0.1.184.
- A pie draws positive values only (zero and negative are left out and the pane says so) and at most 12 slices (the rest become one `Other`). A value that is not a number is skipped and counted, never drawn as zero.
- A series takes no color: colors come from Bolt. Series differ by line style and marker as well as tint.
- Heatmap grids keep 24 columns and 24 rows; a gauge shows the selected row.
- Nothing here has been drawn in a real Bolt yet: the golden files hold the rows, `check` proves the app file passes lint, and the pane itself is not seen.

## Copy this to build
A dashboard that needs a share of a whole, several lines on one axis, a grid of intensities or one value against a scale.

## Edit only these fields
`scripts/chart-types__config.json`: `endpoints`, `views[].item.extra`, `widget.bind`, `overview.rows`. `scripts/chart-types__fixtures.json`: one raw response per endpoint. Details: `../ENGINE.md`.

## Commands
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.
```
./bolt-apps kit vendor --flat kit/examples/chart-types
./bolt-apps regen kit/examples/chart-types
./bolt-apps check kit/examples/chart-types --update-golden
./bolt-apps lint kit/examples/chart-types --personal
./bolt-apps pack kit/examples/chart-types --personal --version 1.0.1 --out chart-types-1.0.1.boltpack
```
Raise the version each time: Bolt refuses the same or an older one. Keep the pack outside the folder.
