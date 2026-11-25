# tabs-gallery

## What this teaches
The `tabs` right pane Bolt 0.1.185 added: one pane, several views, each tab one whole existing pane over the same rows. Here a line chart, a pie (a pie needs Bolt 182, and 185 has it) and a table of the weekly deploys.

**Needs Bolt 0.1.185 or newer.** A Bolt 184 or older refuses the whole pack that uses `tabs`, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it.

| Key | Meaning |
|---|---|
| `bind.tabs` | 1 to 12 tabs |
| `label` | text, 1 to 40 characters |
| `widget` | `kind` (cards, chart, table, heatmap, gauge, detail, markdown or stack; never tabs), `mode`, `bind` |
| `count_from`, `status` | a row set whose size the tab shows, and `critical` or `warning`: see `../CAPABILITIES.md` (not used in this sample) |

- Only the chosen tab is drawn. The strip does not wrap: it scrolls, and an overflow menu lists every tab.
- Nothing here has been drawn in a real Bolt yet: the golden files hold the rows and `check` proves the app file passes lint.

## Copy this to build
A pane that needs the same rows as a chart, a share and a table, or a dashboard whose views would crowd one pane.

## Edit only these fields
`scripts/tabs-gallery__config.json`: `endpoints`, `views[].item.extra`, `widget.bind`. `scripts/tabs-gallery__fixtures.json`: one raw response per endpoint. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps kit vendor --flat kit/examples/tabs-gallery
./bolt-apps regen kit/examples/tabs-gallery
./bolt-apps check kit/examples/tabs-gallery --update-golden
./bolt-apps lint kit/examples/tabs-gallery --personal
```
