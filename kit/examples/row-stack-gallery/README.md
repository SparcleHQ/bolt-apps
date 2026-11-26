# row-stack-gallery

## What this teaches
A per-row pane (Bolt 0.1.185): the right pane is a `tabs` pane with `mode: selected_row`, so it follows the row you select. The Details tab is a stack (a detail and a gauge; a gauge needs Bolt 182, and 185 has it) bound to that row, the History tab draws only the rows of the set `hist` whose `h_src` equals the selected row's `source` (`where: {h_src: "{{row.source}}"}`), and the Notes tab shows the row's own markdown.

**Needs Bolt 0.1.185 or newer.** A Bolt 184 or older refuses the whole pack that sets `mode: selected_row` on a stack or tabs, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it. With nothing selected the pane says "Select an item to see its details." and draws no part.

| Key | Meaning |
|---|---|
| `mode: selected_row` on `tabs` or `stack` | the pane is bound to the selected row |
| `where: {field: "{{row.field}}"}` | exactly one reference, only in a row pane, at most 6 distinct fields |
| a table, chart, cards or heatmap part (a heatmap needs Bolt 182, and 185 has it) | must name a row set (`bind.from`) in a row pane |

- Nothing here has been drawn in a real Bolt yet: the golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
A list of things (services, alerts, hosts) where each one needs its own details, history and notes.

## Edit only these fields
`scripts/row-stack-gallery__config.json`: `overview.rows[].extra`, `overview.widget.bind`. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps kit vendor --flat kit/examples/row-stack-gallery
./bolt-apps regen kit/examples/row-stack-gallery
./bolt-apps check kit/examples/row-stack-gallery --update-golden
./bolt-apps lint kit/examples/row-stack-gallery --personal
```
