# See it in action

Real Bolt screens for each example app. Sample data is labelled in the pictures (SAMPLE chips or rows). Each entry names the example folder under `kit/examples/` and the row in [`kit/examples/capabilities.json`](../kit/examples/capabilities.json). The key behind each number is in [Anatomy of a Bolt App](anatomy.md). The 76 second video, with captions, is on the site: [sparcle.app/docs/extend/rich-apps](https://sparcle.app/docs/extend/rich-apps).

This page is generated from `docs/gallery.json`, which the website reads too.

## Tiles with meters, trends and badges

![Bolt launcher with the =acme-dash chip: a list of compliance areas on the left and a grid of tiles on the right, each with a big number, a progress meter and a badge such as ON TRACK.](images/acme-dash-overview.png)

Compliance posture as tiles: a number, a meter and a status badge for each.

- Example: [`acme-dash`](../kit/examples/acme-dash)
- Capability row: `pane.tiles`, `widget.cards`
- How to get this: Copy `kit/examples/acme-dash`; the overview view uses `kind: cards` with `bind.layout: "tiles"`.

## Drill and Back

![Launcher showing =acme-dash with the input "controls C-017": a Back row, then rows of linked tasks, with a detail pane on the right.](images/acme-dash-drill.png)

![Animation: the =acme-dash list, Enter drills into controls, a detail pane appears, then Back returns to the overview.](images/acme-dash-drill-and-back.gif)

Press Enter on a row to drill in; the first row is always Back.

- Example: [`acme-dash`](../kit/examples/acme-dash)
- Capability row: `nav.drill`, `nav.back`
- How to get this: Give the overview rows a `nav` and set `presentation.view_arg`; see `acme-dash/utilities/acme-dash.yaml`.

## Per-row detail pane with actions

![Launcher showing =pulse-feed: a ranked list of Hacker News stories and, for the selected story, a pane with source, author, age, score and two buttons, Open post and Copy quote.](images/pulse-feed-story-pane.png)

![Animation: moving down the story list while the pane on the right follows each story, then the Open post and Copy quote buttons.](images/pulse-feed-story-pane-actions.gif)

Each story gets its own pane, with Open post and Copy quote.

- Example: [`pulse-feed`](../kit/examples/pulse-feed)
- Capability row: `pane.per_row`, `actions.footer`, `widget.entity_preview`
- How to get this: Copy `kit/examples/pulse-feed`: an `entity_preview` pane plus a top-level `actions` list.

## Entity preview with a tile above

![Launcher showing =sky-watch with the word paris: a temperature tile (13.6 C, Paris, France) above source, time and wind, with Open source and Copy summary buttons.](images/sky-watch-paris-pane.png)

![Animation: typing paris after =sky-watch and the weather pane filling in.](images/sky-watch-paris.gif)

Type a city and get a temperature tile with the facts below.

- Example: [`sky-watch`](../kit/examples/sky-watch)
- Capability row: `widget.entity_preview`, `pane.tiles`
- How to get this: Copy `kit/examples/sky-watch`: `bind.tiles_above` inside an `entity_preview`.

## Several live sources in one list

![Launcher showing =sky-watch: four rows (space station, next launch, earthquakes, weather) with a pane about the selected launch.](images/sky-watch-overview.png)

One word, four sources: the space station, launches, quakes and weather.

- Example: [`sky-watch`](../kit/examples/sky-watch)
- Capability row: `parallel.sources`, `api.keyless`
- How to get this: Copy `kit/examples/sky-watch` (no key needed).

## Chart

![Launcher showing =expense-tracker chart: a list of days with amounts and a bar chart on the right with latest 21.8 and peak 188.](images/expense-tracker-chart.png)

A bar chart of daily spending next to the numbers.

- Example: [`expense-tracker`](../kit/examples/expense-tracker)
- Capability row: `widget.chart`, `pane.chart_mixed`
- How to get this: Copy `kit/examples/expense-tracker`, the `chart` view (`kind: chart`, type bar).

## Tiles with a sparkline and a sample label

![Launcher showing =expense-tracker: three menu rows and tiles for money spent (544 USD with a line), expenses logged and the biggest expense.](images/expense-tracker-tiles.png)

Spent this month against the budget, labelled as sample data.

- Example: [`expense-tracker`](../kit/examples/expense-tracker)
- Capability row: `pane.tiles`, `sample.mode`
- How to get this: Copy `kit/examples/expense-tracker`; sample data shows until a key is added.

## Tabs in the right pane

![The =obs overview: a list of views on the left, tabs Overview, Trend and Alerts above tiles with rings and sparklines on the right.](images/obs-overview-tabs.png)

=obs with Overview, Trend and Alerts as tabs over one list. Tabs need Bolt 0.1.185 or newer, which is not in a public release yet. The picture is an unedited capture of a real Bolt on public demo data.

- Example: [`tabs-gallery`](../kit/examples/tabs-gallery)
- Capability row: `widget.tabs`
- How to get this: Copy `kit/examples/tabs-gallery` for the tabs.

## A table with a filter and marks

![The =obs Alerts tab: a filter box above a table of firing alerts with a mark, the alert name and open minutes.](images/obs-alerts-tab.png)

The =obs alerts as a table: a filter box, a mark per row and the open minutes. Public demo data.

- Example: [`widget-gallery`](../kit/examples/widget-gallery)
- Capability row: `widget.table`, `pane.table_bars_mark`
- How to get this: Copy `kit/examples/widget-gallery` for a table with bars and marks.

## A trend with a limit line and event marks

![The =obs Trend tab: a line chart of firing alerts with a dashed limit line and event marks along the top.](images/obs-trend-tab.png)

Firing alerts over recent runs: a line, a dashed limit and marks where the count went over it. Public demo data.

- Example: [`widget-gallery`](../kit/examples/widget-gallery)
- Capability row: `widget.chart`, `pane.chart_limit_marker`
- How to get this: Copy `kit/examples/widget-gallery` for a chart with a limit line and markers.

## Detail pane with Before, After and What changed

![Launcher showing =pipeline-board changes: Run 305 selected and a detail pane with Before, After and What changed.](images/pipeline-board-detail-pane.png)

![Launcher showing =pipeline-board: three menu rows and tiles for runs, passed and failed, labelled as sample data.](images/pipeline-board-overview.png)

A change shown as Before and After next to the run list.

- Example: [`pipeline-board`](../kit/examples/pipeline-board)
- Capability row: `widget.detail`
- How to get this: Copy `kit/examples/pipeline-board`, the `changes` view.

## Row Open and Copy (a place in Maps)

![Launcher showing =places-list: five places and a pane for Lantern Park with kind, distance, coordinates and Open and Copy buttons.](images/places-list-detail-pane.png)

![Launcher showing =places-list: one Nearby places row and a tile showing 3 of 5 places open now, labelled as sample data.](images/places-list-overview.png)

Each place opens in the browser map and copies as text.

- Example: [`places-list`](../kit/examples/places-list)
- Capability row: `actions.maps_link`, `actions.row`
- How to get this: Copy `kit/examples/places-list`; the row carries `open_url`.

## Form app

![Launcher showing =unit-convert as a form: Amount 12500, From km, To mi, with Cancel and Convert buttons.](images/unit-convert-form.png)

![Animation: filling the Amount, From and To fields and pressing Convert.](images/unit-convert-form.gif)

Fill Amount, From and To, press Convert.

- Example: [`unit-convert`](../kit/examples/unit-convert)
- Capability row: `inputs.form`
- How to get this: Copy `kit/examples/unit-convert`; `inputs` plus `submit.label`.

## Form result and detail pane

![Launcher after Convert: seven rows from 12500 km = 7767.14 mi to yards, with a pane showing Result, Formula, Reverse and Kind.](images/unit-convert-result-detail.png)

![The same result list with the feet row selected and its Copy button showing at the right of the row.](images/unit-convert-result-row-copy.png)

One row per unit; the pane shows result, formula and reverse.

- Example: [`unit-convert`](../kit/examples/unit-convert)
- Capability row: `widget.detail`
- How to get this: Same example; `right_widget.kind: detail`.

## Install flow

![Bolt dialog Install utility pack for Acme Dash, listing a HIGH RISK block and the pack files, with Cancel and Accept and install buttons.](images/install-review-card.png)

![Bolt dialog Run Acme Dash, with the list of files and their hashes and the Review files and Accept and continue buttons.](images/acme-dash-run-approval.png)

![Animation: the install review card, then the first-run approval dialog.](images/install-flow.gif)

Review what the pack can do, accept, then approve the first run.

- Example: [`acme-dash`](../kit/examples/acme-dash)
- Capability row: `platform.reapprove`, `permissions.block`
- How to get this: Drop the `.boltpack` on the launcher; see `kit/examples/QUICKSTART.md`.

## Terminal flow

![Terminal showing ./bolt-apps new script-template my-tool, then ./bolt-apps check my-tool passing ten cases.](images/terminal-new-check.png)

![Terminal showing the ship output: the pack file name and the five install steps.](images/terminal-ship.png)

`new`, `check`, `ship`: from template to a pack you can install (the app is named my-tool).

- Example: [`script-template`](../kit/examples/script-template)
- Capability row: none (command line flow)
- How to get this: See `kit/examples/QUICKSTART.md`.

## Not shown yet

Table pane, JSON tree, branch explorer, repo-radar chart and the around example with live data have no clean recording yet.
