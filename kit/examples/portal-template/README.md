# Portal template

A copy-and-edit template for a Bolt App that shows a web API in the launcher: tiles, drill down and Back, a detail panel per row, a cache, and plain error rows. You change data. You do not write code.

It is a tier 3 personal-use app (it runs a script and calls the network), so it lives here and not in `apps/`.

## Change these 4 things

| # | File | What to change |
|---|---|---|
| 1 | `scripts/portal-template__config.json` `app`, `api` | App id, chip, title; `base_url`, the key variable name, the `.env` path, the auth header |
| 2 | `scripts/portal-template__config.json` `endpoints` | One entry per API path, with `map` from your field names to the names the views use (`"title": "name"`, dotted paths such as `"owner": "assignee.name"` work) |
| 3 | `scripts/portal-template__config.json` `stats`, `overview`, `views` | Counters, the tiles on the overview, and per view: row title, subtitle, tile, up to 5 detail fields, body, link, `children` for a drill to a second list |
| 4 | `scripts/portal-template__fixtures.json` | A real response saved per endpoint. `check` runs on it (`"fixture": true` in `check.json`); the shipped app is live (`api.fixture_default: false`) and, with no key, shows labelled sample data (`api.on_missing_key: sample`) |

Then rebuild the app file and check:

```
bolt-apps regen .
bolt-apps kit vendor --flat .          # the kit as one file, so the app can be packed
bolt-apps check . --update-golden     # review the golden/ diff once
bolt-apps check .
```

Run these from inside the app folder. If you changed the id, write it in place of `portal-template` in the first command: the yaml file name is the id. Keep `id` the same in `config.json`, `bolt-app.json`, the yaml file name and the folder name (`bolt-apps lint` refuses a mismatch). Never edit the yaml by hand: it is generated from `config.json` so the labels in the right panel always match the rows. At most 7 views besides the overview (the launcher refuses an app file with more than 8).

## What you get

| Feature | Where it comes from |
|---|---|
| Overview tiles that drill into a list | `overview.rows[]` with `view`; the tile uses `stats` |
| Back row first in every list and detail | built in |
| Level 3: a detail view with related rows | `views[].children` (rows of another view whose `match` field equals this row's id) |
| Detail panel per row, Open and Copy buttons | `item.fields`, `item.body`, `item.url` |
| Filter by one word | type `=<chip> tickets open`; the list keeps rows that contain the word. The row contract has no filter field, so this works through the query word only |
| Cache 45 s, old copy up to 24 h | `cache.ttl`, `cache.stale_max`; a failure is never cached |
| Offline, rejected key, no key, partial load | one plain row each, Enter retries |
| Key | environment variable first, then the first `NAME=...` line of the `.env` file (must be `chmod 600`). Never printed, cached or put in a row |
| Fixture mode | `"fixture": true` in `check.json` (the whole app or one case), or `BOLT_APP_FIXTURE=1` in a terminal. No key, no network. The shipped app stays live: an installed pack cannot be flipped, because `config.json` is signed and Bolt passes no environment |
| Preview the error rows | in fixture mode type `=<chip> tickets demo-offline`, `demo-stale`, `demo-auth` or `demo-nokey` |

## Not covered

- Paging: the engine reads the first response of each path. A list is capped at 50 rows.
- Anything but GET. The app is read-only on purpose.
- The real launcher. `bolt-apps check` runs the script on recorded data and checks the rows against the contract. It does not draw them.

## Pack and install
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.

```
bolt-apps lint . --personal
bolt-apps pack . --personal --version 1.0.1 --out ../portal-template-1.0.1.boltpack
```

Two rules that bite everyone once:

- **Raise the version every time.** Bolt refuses a pack whose version is the same as, or older than, the one installed (`same_or_older_version`). Pass `--version X` with a higher number on each build, and write the pack outside the folder: `--out ../<id>-<ver>.boltpack`. Without `--out`, `pack` already writes outside the app folder.
- **Where the API key lives.** Put it in the system keychain, or in `~/.config/<app id>/.env` (one line `NAME=value`, `chmod 600`). A key exported in your shell never reaches the script when Bolt runs it: Bolt starts the script with an empty environment, so a shell variable works in your terminal and in tests only (see `../ENGINE.md`, "Where to store keys").

Drop the `.boltpack` on the Bolt launcher or Bolt Apps. `check.json`, `golden/` and the kit lock stay on your machine.

## Tests

`check.json` holds the cases (golden rows, filter, detail, error rows). The live path (key, cache, stale copy, errors) is tested against a local server in `kit/python/tests/test_portal_engine.py`.
