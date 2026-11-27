# cloud-cost

## What this teaches
A cloud bill in four tabs: Overview (tiles with a spark, a bullet, a ring and a plain number, a savings plan coverage gauge with a floor of 60 percent and a target of 80 percent, Bolt 182 or newer, and an area chart of monthly spend by service with a limit line and two event marks, Bolt 182 or newer), Services (a table of spend by service with bars and the change from last month), Teams (tiles and a table of what each team spends against the budget) and Anomalies (a table of the extra cost on a service on a day).

**Needs Bolt 0.1.185 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `tabs` | four tabs: Overview, Services, Teams and Anomalies (Bolt 185 or newer) |
| `cards.visual_from` | one tile visual per row: spark, bullet, ring, number |
| `gauge.thresholds` | a floor at 60 percent and a target at 80 percent (Bolt 182 or newer) |
| `chart.limit, limit_label, marker` | a limit line and two event marks on the area chart |
| `table bars, mark` | spend bars and a tone mark |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Drawn by a real Bolt dev build (0.1.185 or newer) on 2026-11-26: the [gallery pictures](../../../docs/gallery.md) are unedited captures of that run. The golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
A spend or budget view where the same rows feed tiles, a budget meter, a chart and a table.

## Edit only these fields
`scripts/cloud-cost__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/cloud-cost__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/cloud-cost
./bolt-apps check kit/examples/cloud-cost --update-golden
./bolt-apps lint kit/examples/cloud-cost --personal
```
