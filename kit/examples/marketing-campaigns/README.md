# marketing-campaigns

## What this teaches
Campaigns in four tabs: Overview (tiles, a donut of spend by channel and a weekly spend line, Bolt 182 or newer), Campaigns (a table of spend, revenue and return with spend bars), Creatives (a table of views, click rate and spend with spend bars) and Watch (campaigns under 100% ROI, with a warning status on the tab while the list is not empty). Each tab with a row set shows its count.

**Needs Bolt 0.1.185 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `tabs[].count_from` | campaign, creative and watch counts on the tabs |
| `tabs[].status` | warning on the Watch tab |
| `chart type donut` | spend by channel with the total in the centre (Bolt 182 or newer) |
| `table bars, mark` | spend bars, and a tone mark on the watch rows |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Drawn by a real Bolt dev build (0.1.185 or newer) on 2026-11-26: the [gallery pictures](../../../docs/gallery.md) are unedited captures of that run. The golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
Any app with a summary, several lists and a short list that needs attention.

## Edit only these fields
`scripts/marketing-campaigns__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/marketing-campaigns__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/marketing-campaigns
./bolt-apps check kit/examples/marketing-campaigns --update-golden
./bolt-apps lint kit/examples/marketing-campaigns --personal
```
