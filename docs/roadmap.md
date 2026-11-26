# Bolt Apps: what works today and what is coming

Last updated 2026-11-25. This page says what you can build with Bolt Apps now, and what we are working on. We do not give dates. If a thing is under "coming", it is not available yet.

## What works today

Each row below is covered by this repository's tests; check the version note on each row. Tabs need Bolt 0.1.185 or newer, which is not in a public release yet; set `min_bolt_version` to match (the checker tells you).

| You want | What you write | Notes |
|---|---|---|
| Numbers that stand out | `cards` with `layout: tiles`: a value, a unit, a trend line, a target, a limit | Rings, meters and bullet bars |
| A table you can scan | `table` with columns, number formats, bars, tone marks and totals | Sorting and filtering are built in |
| A trend | `chart` with a line or area, a limit line, and marks for events | A deploy or an alert shows as a marker |
| Several views in one pane | `tabs` with a count and a status shape per tab | Needs `min_bolt_version` 0.1.185 |
| A heatmap or a gauge | `heatmap`, `gauge` | See [`kit/examples/CAPABILITIES.md`](../kit/examples/CAPABILITIES.md) |
| Several widgets in one view | `stack` | Tiles, a chart and a table together |
| A check before you ship | `bolt-apps lint`, `check`, `pack` | The checker works out the safety tier and refuses a lower claim |
| A plain-words sheet at install | Bolt lists what a pack can do before it runs | You confirm it |

See [Anatomy of a Bolt App](anatomy.md) for which key draws what, and the [gallery](gallery.md) for the screens.

## What we are working on (not available yet)

| Idea | What it would let you do | State |
|---|---|---|
| Draw any d3 widget | Write d3 drawing code that Bolt would run isolated from the network, files and accounts. Bolt would supply the data, size, theme, keyboard handling and tooltips. Treemaps, sankeys, maps and your own layouts would use one contract. | Design stage. We have not proven the sandbox on every platform. |
| Colour that means something | Green, amber and red on tile values, rings and list rows, taken from Bolt's theme | Planned |
| Text in a tile | Show a word such as "Degraded" or a country name in a tile | Planned |
| Rich detail panes | A pane for the selected row that holds tiles, a chart and tables | Planned |
| Chart extensions | Stacked bars and areas, a forecast band, scatter and bubble | Planned |
| Better loading | Show the last results at once with "updated 2 min ago, refreshing" | Planned |
| Forms next to a chart | An input form inside the right pane | Under discussion |
| Live data | Results that update as a source answers | Later, on a separate streaming design |

Pictures of the new widgets will appear here once they exist in Bolt itself. We will not show hand-drawn pictures as if they were Bolt.

## How we check ourselves

We build sample apps and render them through the real Bolt widgets. When a sample shows something Bolt cannot draw, we write the gap down and fix it. That is how we found that a tile could not show a word, and that a table needs better number formatting.

## Try it

Pack an app with `bolt-apps pack`, then drop the `.boltpack` file on the Bolt launcher. Bolt shows what the pack can do before you confirm.
