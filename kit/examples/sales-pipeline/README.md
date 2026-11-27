# sales-pipeline

## What this teaches
One wide chart first, tiles under it, then two tables in one stack (a stage funnel with bars and the top deals). A funnel widget does not exist, so the funnel is a table with bars. Account names are invented.

**Needs Bolt 0.1.184 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.184 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `cards.visual_from` | one tile visual per row: spark, bullet and ring |
| `chart.series` | two area series on one chart, Open and Commit |
| `chart.limit, limit_label, marker` | a quota line and event marks on the pipeline chart |
| `table bars, mark` | deal bars and a tone mark |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Not drawn in a real Bolt yet: the golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
A pipeline or forecast view where one wide chart and two tables tell the story.

## Edit only these fields
`scripts/sales-pipeline__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/sales-pipeline__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/sales-pipeline
./bolt-apps check kit/examples/sales-pipeline --update-golden
./bolt-apps lint kit/examples/sales-pipeline --personal
```
