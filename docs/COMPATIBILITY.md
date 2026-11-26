# Compatibility

What stays working when Bolt moves from one version to the next, and what an older Bolt does with an app that uses something newer.

## Older apps keep working in 184

An app that ran on Bolt 0.1.183 keeps running on Bolt 0.1.184 with no change. Checked on 340 real app files (every distinct app file in the bolt-apps history, installed apps and scratch apps) against the 0.1.183 validator and 184 main: nothing accepted by 183 is refused by 184. The validator change is additive (a table column `format` gained `compact`, `bytes` and `duration`). An existing app does not need a new `min_bolt_version`, a rebuild or a new pack.

### What looks different on an old-shaped app

Data and meaning are unchanged. These look changes are not opt-in:

| Pane | Change in 184 |
|---|---|
| cards, `layout: tiles` | a head row is added; a tile is about 9 px taller |
| chart (line, bar, multi-series) | a y-axis with tick labels and rules is drawn by default |
| chart, area, single series | the legend is replaced by a head with the large latest value |
| table | header text is 12 px; the sort arrow is hidden until the table is sorted |

Not measured: real Bolt 181 and 182 binaries (the check used the 183 source), screenshots of the look changes, and updating an already installed pack on an older Bolt.

## Newer apps on an older Bolt

`min_bolt_version` in `bolt-app.json` is a promise from you, the author. Nothing in Bolt reads it, so it cannot hold a pack back. It is a lint-only promise.

A Bolt older than a widget does not know its key or kind, so it refuses the WHOLE pack and no app in that pack installs. It does not fall back to a plainer widget. What the person sees:

- Bolt 0.1.181 to 0.1.183: "This pack could not be verified, so it was not installed. Check that the file is a complete, unmodified .boltpack." This wording is misleading and cannot be changed on those releases.
- Bolt 0.1.184, for a new kind or key: "This app needs a newer version of Bolt than this one (it uses X). Update Bolt, then install it again." A new value of an existing key (for example `format: compact`) gets a generic sentence instead.

So:

- Give a pack that uses a new widget only to people on a Bolt that has it (184 or newer for the 0.1.184 widgets).
- Split packs so an old app is never held back by a new one. Keep apps that use 0.1.184 widgets in their own pack, and older apps in a pack of their own.
- Large demo apps that use the new widgets (showcase and obs-rich) ship as their OWN packs and are never bundled with older apps.
- Set `min_bolt_version` to the version that introduced the widget, so your own pack records the promise.

### What the toolkit enforces

`check` and `verify` report the error `bind_needs_newer_bolt` for an app that uses a key or kind newer than its declared `min_bolt_version`, and a built pack read without its listing gets a warning. The capabilities table gives each widget's `since` version.

### A stack or tabs for the selected row (Bolt 0.1.185)

A stack or tabs pane with `mode: selected_row` shows several panes for the row you selected, and a `where` value can be exactly `{{row.field}}` to pick that row's own rows from a row set. Both are first read by Bolt 0.1.185. Lint covers both with the same `bind_needs_newer_bolt` error, and an older Bolt refuses the pack:

- `mode: selected_row` on a stack or tabs: a Bolt 0.1.184 or older refuses the whole pack (a stack says "a stack needs mode: list_data"; tabs is an unknown kind). It installs nowhere, so there is no plainer fallback. Set `min_bolt_version` to `0.1.185`.
- `{{row.field}}` in a `where`: it only works inside a per-row pane, so it always travels with `mode: selected_row`, which a Bolt 0.1.184 or older refuses wholesale. In any other pane Bolt 0.1.185 and lint refuse it. The remaining gap is that no Bolt reads `min_bolt_version` yet, so nothing stops an older Bolt from being handed the pack: lint holds you to the promise, and the install-time check (not built) will enforce it.

Take both keys out and the app needs no newer Bolt: a single `detail` pane per row (the older row pane) still works on every Bolt that has it. The rule names are `stack.mode.selected_row`, `tabs.mode.selected_row` and `where.row_ref` in `feature_since` of `schema/bolt-rules.json`.
