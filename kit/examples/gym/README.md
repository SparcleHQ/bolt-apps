# gym

## What this teaches
A benefit on one pane: a ring first, tiles under it, a claims chart against an even pace, then the claims list. The ring reads a field every row carries, so it never shows "No value" when another row is selected.

**Needs Bolt 0.1.184 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.184 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `cards.visual_from` | one tile visual per row: spark, bullet, ring, number |
| `gauge.thresholds` | a watch line at 80 percent (Bolt 182 or newer) |
| `chart.limit, limit_label, marker` | a pace line and event marks on the area chart |
| `table bars, mark` | claim bars and a tone mark |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Not drawn in a real Bolt yet: the golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
A benefit or allowance view where one ring, the tiles, the pace and the claims all come from the same rows.

## Edit only these fields
`scripts/gym__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/gym__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/gym
./bolt-apps check kit/examples/gym --update-golden
./bolt-apps lint kit/examples/gym --personal
```
