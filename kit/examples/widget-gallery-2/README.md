# widget-gallery-2

## What this teaches
The three panes `widget-gallery` has no room for, because a personal app may have at most 8 views including the overview and that gallery already uses all 8. Open `=widget-gallery-2` and press Enter on each row.

| View | kind and mode | bind keys | row fields it reads |
|---|---|---|---|
| card | `card`, selected_row | title, subtitle, actions (`copy`) | any |
| grid | `image_grid`, list_data | src, caption, alt, columns (1 to 8) | `src`, a field holding an inline image |
| cardsimg | `cards`, list_data, layout grid | title, subtitle, image, footer | `src` the same way |

## Images: inline only (read from the launcher's image rules)
A User App pane draws only a `data:image/png|jpeg|gif|webp|avif|bmp` source of at most 1 MiB, and 4 MiB in total per pane. Any `http`, `https`, `file` or relative source draws a placeholder with the alt text and makes no request. So the app must put the image bytes in the row. These swatches are 24 by 24 PNGs (about 200 characters each) generated with the standard library. Row field values are cut at 4,000 characters, so an inline image in a row field must be small: a thumbnail, not a photo.

## Tile visuals (Bolt 0.1.184)
Two more views draw the tile keys of Bolt 0.1.184 on a cards pane with `layout: tiles`. `visual` is a fixed word (`meter`, `ring` or `bullet`), so each pane draws one visual and each visual has its own view. `bolt-app.json` says `min_bolt_version` `0.1.184`; an older Bolt refuses the whole pack.

| View | bind keys | What each row shows |
|---|---|---|
| tiles-184 | `visual: bullet`, `max`, `target`, `trend`, `limit` | a bullet with a target mark; a sparkline with a dashed limit line; a target that is not a number (no mark); a limit that is not a number (no line); a max that is not a number (the value only) |
| ring-184 | `visual: ring`, `max` | a ring; a value over max (full ring); a max that is not a number (the value only) |

Not run in a real Bolt: the drawn pixels have not been seen.

## Sample data
Six colour swatches generated for this example, labelled SAMPLE DATA in each note. There is no API behind it (`api.example.com` is a placeholder and `fixture_default` is true).

## Copy this to build
A gallery, a palette, an avatar list, a screenshot index. Replace `endpoints.swatches` and the `item.extra` fields; keep the image small.

## Edit only these fields
`scripts/widget-gallery-2__config.json`: `endpoints`, `overview.rows`, each view's `item.extra` and `widget.bind`. `scripts/widget-gallery-2__fixtures.json`: the recorded or sample response.

## Commands
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.
```
./bolt-apps kit vendor --flat kit/examples/widget-gallery-2
python3 kit/examples/widget-gallery-2/scripts/widget-gallery-2__engine.py --emit-yaml > kit/examples/widget-gallery-2/utilities/widget-gallery-2.yaml
./bolt-apps check kit/examples/widget-gallery-2 --update-golden
./bolt-apps lint kit/examples/widget-gallery-2 --personal
./bolt-apps pack kit/examples/widget-gallery-2 --personal --version 1.0.1 --out widget-gallery-2-1.0.1.boltpack
```
Not run in the real launcher: how the grid and the cards draw the images is read from the launcher source, not seen on screen.
