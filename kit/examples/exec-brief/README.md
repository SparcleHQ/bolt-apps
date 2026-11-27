# exec-brief

## What this teaches
A story stack: one tile strip, then three full-width charts one under another. The chart title is the one-line takeaway, so each chart says what to notice. Two charts side by side need the per-row stack, which needs Bolt 0.1.185 or newer, so each chart is full width here.

**Needs Bolt 0.1.184 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.184 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `cards.visual_from` | one tile visual per row: spark and bullet |
| `chart.series` | two series on one chart |
| `chart.limit, limit_label` | a floor line on the cash chart |
| `chart.marker` | event marks on the revenue chart |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Not drawn in a real Bolt yet: the golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
A monthly review pack where the numbers read as a story, one takeaway per chart.

## Edit only these fields
`scripts/exec-brief__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/exec-brief__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/exec-brief
./bolt-apps check kit/examples/exec-brief --update-golden
./bolt-apps lint kit/examples/exec-brief --personal
```
