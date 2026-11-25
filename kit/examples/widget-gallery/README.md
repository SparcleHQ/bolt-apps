# widget-gallery

## What this teaches
Which right-hand panes a personal app can draw and the exact `bind` keys each needs. Open `=widget-gallery` and press Enter on each row: tiles with trend and change, a bar chart, a sortable table with totals, a detail list, a JSON tree, a line diff, an entity preview with a meter tile, and markdown.

## Copy this to build
Any app that shows data in a chart, table, tree, diff or detail pane. Pick the view closest to yours, copy its `views[]` entry and its fixture.

## Edit only these fields
`scripts/widget-gallery__config.json`: `endpoints` (path and `map`), each view's `item.extra` (the row fields the pane reads), `widget.bind`. `scripts/widget-gallery__fixtures.json`: one raw response per endpoint. Then `./bolt-apps regen <this app folder>` and run check. Every option is in `../ENGINE.md`.

## Pane contract (read from the launcher source)
| kind | mode | bind keys | row fields it reads |
|---|---|---|---|
| cards (tiles) | list_data | title, value, unit, delta, delta_label, max, trend, subtitle, badge, footer, layout | the tile fields, `trend` |
| chart | list_data | type (line, bar, sparkline), x, y, values, label, color, unit, limit, limit_label, marker (Bolt 0.1.184) | numeric field named by y; the marker field |
| table | list_data | columns (field, label, align, total, format, unit, bars, mark: Bolt 0.1.184), sort, totals_label | one field per column |
| detail | selected_row | title, subtitle, fields (label, value, copy) | any |
| json_tree | selected_row | source | `data` (an object) |
| diff | selected_row | left, right, leftLabel, rightLabel | text with line breaks |
| entity_preview | selected_row | title, subtitle, image_url (a 40 px avatar), hero (src, alt, caption, credit: Bolt 182 and later, see ../ENGINE.md), tiles_above, fields (label, value, kind, tone), body, actions | tile and `f1..f5` |
| markdown | selected_row | title, subtitle, body, actions | markdown text |

A chart or table plots every row, so those views carry no Back or refresh rows.

## Needs Bolt 0.1.184
The chart view draws a dashed `limit` line labelled "capacity" and two `marker` marks (a release and a hotfix), and the table view draws `bars` on Commits and a `mark: tone` glyph on Health. These keys are newer than Bolt 0.1.183, so `bolt-app.json` says `min_bolt_version` 0.1.184 and the gallery needs that Bolt or newer. A chart or table pane that uses them is drawn by Bolt with its own accent and grey tokens, by shape and pattern, never red or green.

verified: not verified in real Bolt. The sample runs and the check goldens pass against stubbed commands; no Bolt 0.1.184 has drawn these two views, and light and dark have not been looked at.

## Not available to a personal app
Bolt shows a plain message instead of the pane for these kinds, because they read their own state and ignore the app's data:

| kind | what Bolt says |
|---|---|
| image | This app asks for an image pane, which cannot show app data. Use image_grid for pictures. |
| color, weather, date, calc | This app asks for a (kind) pane, which cannot show app data. Use table, detail, cards or chart. |

Source: the launcher's own pane code. `card` and `image_grid` are in `../widget-gallery-2`. `map` draws the launcher's own state, reads no bind keys and cannot show app data: use an Open in Maps url action instead.

## Commands
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.
See `../ENGINE.md` for every option. Install: drop the `.boltpack` on the Bolt launcher.
```
./bolt-apps lint kit/examples/widget-gallery --personal
./bolt-apps check kit/examples/widget-gallery
./bolt-apps pack kit/examples/widget-gallery --personal --version 1.0.1 --out ../widget-gallery-1.0.1.boltpack
```

The card pane, the image grid and image cards are in `../widget-gallery-2` (this gallery already uses the launcher limit of 8 views).
