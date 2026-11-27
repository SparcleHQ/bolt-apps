# support-desk

## What this teaches
A support desk in four tabs: Queue (tiles and a ticket table with age bars and an SLA tone mark), SLA (a gauge with a floor of 85 percent and a target of 95 percent, Bolt 182 or newer, a bar chart of SLA met per day against the target line, and the tickets still left), Volume (new tickets per day over the last 14 days and a table of the channel, the reply time and the speed) and Agents (tiles and a table of open tickets per agent against a load cap). Each tab shows a count; the SLA tab also shows a critical status while tickets are at risk.

**Needs Bolt 0.1.185 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `tabs[].count_from` | the size of a row set, shown on the tab |
| `tabs[].status` | critical on the SLA tab while any ticket is at risk |
| `table mark tone` | words ok, warn, error and neutral draw a glyph |
| `chart.limit` | a target line on the bars |
| `tabs` | four tabs: Queue, SLA, Volume and Agents (Bolt 185 or newer) |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Drawn by a real Bolt dev build (0.1.185 or newer) on 2026-11-26: the [gallery pictures](../../../docs/gallery.md) are unedited captures of that run. The golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
Any app whose views would crowd one pane and need counts on their tabs.

## Edit only these fields
`scripts/support-desk__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/support-desk__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/support-desk
./bolt-apps check kit/examples/support-desk --update-golden
./bolt-apps lint kit/examples/support-desk --personal
```
