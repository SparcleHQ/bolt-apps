# finance-pnl

## What this teaches
Profit and loss in three tabs: Overview (tiles with a revenue spark, an operating margin bullet against budget and a net income number with a delta, then a two-line chart of actual against budget with a plan ceiling and event marks, then a variance table with variance bars and an ok or error mark), Trend (an operating margin gauge with a floor of 18 percent and a plan of 22.1 percent, Bolt 182 or newer, then the margin by month against the plan line, then the revenue run rate) and Detail (a table of revenue by business unit with variance bars and a mark).

**Needs Bolt 0.1.185 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `tabs` | three tabs: Overview, Trend and Detail (Bolt 185 or newer) |
| `chart.series` | two lines, Actual and Budget |
| `chart.limit, marker` | a plan ceiling and event marks |
| `table bars, mark` | variance bars and a favorable or unfavorable tone mark |
| `cards.target` | the budget as a target on a bullet |
| `gauge.thresholds` | a floor at 18 percent and a plan at 22.1 percent (Bolt 182 or newer) |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Drawn by a real Bolt dev build (0.1.185 or newer) on 2026-11-26: the [gallery pictures](../../../docs/gallery.md) are unedited captures of that run. The golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
Any plan against actual comparison.

## Edit only these fields
`scripts/finance-pnl__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/finance-pnl__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/finance-pnl
./bolt-apps check kit/examples/finance-pnl --update-golden
./bolt-apps lint kit/examples/finance-pnl --personal
```
