# inventory

## What this teaches
A warehouse in three tabs: Floor (tiles with a bin fill ring, a stock spark and a below-reorder bullet, then a bin fill heatmap of eight aisles by six shelves, Bolt 182 or newer), Reorder (a low-stock table with on-hand bars, cover days, value and a stock tone mark) and Movement (units received and shipped per week, then a table of the value by category).

**Needs Bolt 0.1.185 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `tabs` | three tabs: Floor, Reorder and Movement (Bolt 185 or newer) |
| `heatmap x, y, value` | aisle across, shelf down, fill percent per cell (Bolt 182 or newer) |
| `table bars, mark` | on-hand bars and a stock tone mark |
| `cards.visual_from` | ring, spark, bullet and number tiles |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Drawn by a real Bolt dev build (0.1.185 or newer) on 2026-11-26: the [gallery pictures](../../../docs/gallery.md) are unedited captures of that run. The golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
Stock, capacity or utilisation where a grid and a short list sit together.

## Edit only these fields
`scripts/inventory__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/inventory__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/inventory
./bolt-apps check kit/examples/inventory --update-golden
./bolt-apps lint kit/examples/inventory --personal
```
