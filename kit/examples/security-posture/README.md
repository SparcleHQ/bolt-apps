# security-posture

## What this teaches
Open security findings in three tabs: Posture (tiles with a spark, a bullet and a ring, a median days to fix gauge with a target of 14 days and a warning at 21 days, Bolt 182 or newer, and a heatmap of open findings by team and severity, Bolt 182 or newer), Findings (a table of the findings with age bars and severity tone marks) and Trend (open findings over the last 13 weeks, then a table of the days to fix by level against the target). Ids are labelled SAMPLE.

**Needs Bolt 0.1.185 or newer.** An older Bolt refuses the whole pack, so `bolt-app.json` sets `min_bolt_version` 0.1.185 and `./bolt-apps lint` fails without it.

| Key | What it does here |
|---|---|
| `tabs` | three tabs: Posture, Findings and Trend (Bolt 185 or newer) |
| `gauge.thresholds` | a target at 14 days and a warning at 21 (Bolt 182 or newer) |
| `heatmap x, y, value` | teams across, severities down, a count per cell (Bolt 182 or newer) |
| `table bars, mark` | age bars and a severity tone mark |

- Runs on built-in sample data, no network. The first row says Sample data; set `api.on_missing_key` to `setup` and add your key to run on your own data.
- One overview row per sample record feeds the right pane through named row sets (`extra.set`); the list on the left is the rows, the picture is the right pane.
- Back: the About row opens a drilled view; the engine adds the Back row, as in the other examples.
- Drawn by a real Bolt dev build (0.1.185 or newer) on 2026-11-26: the [gallery pictures](../../../docs/gallery.md) are unedited captures of that run. The golden file holds the rows and `check` proves the app file passes lint.

## Copy this to build
A risk or compliance view with a target and a spread across groups.

## Edit only these fields
`scripts/security-posture__config.json`: `overview.widget.bind` (the panes), `overview.rows` (the sample rows, tagged by `extra.set`). `scripts/security-posture__fixtures.json` only feeds the About view. Details: `../ENGINE.md`.

## Commands
```
./bolt-apps regen kit/examples/security-posture
./bolt-apps check kit/examples/security-posture --update-golden
./bolt-apps lint kit/examples/security-posture --personal
```
