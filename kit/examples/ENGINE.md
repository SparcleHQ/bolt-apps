# The shared engine: every config option, once

> **Chip equals id:** the app file's `chip` must be the app's `id` (the launcher looks apps up by id, in Bolt 181 and main); `lint` refuses anything else as `chip_not_id`.

> **Apps built before this change:** remove the old app in Bolt (Settings, Desktop App, User Apps; the Remove button is on the app's row on 181, and newer builds also show it in the expanded panel; do not delete files by hand), run `./bolt-apps new <template> <id>`, copy your own `config.json` and `fixtures.json` over the new ones, re-run `./bolt-apps check`, then `./bolt-apps ship`.

`bolt-apps` in this page means `./bolt-apps`, run from the root of the clone. Limits live in [the rules table](QUICKSTART.md#4-the-rules-table); what is supported is in [CAPABILITIES.md](CAPABILITIES.md).

All apps here run the same engine, kept as `scripts/<id>__engine.py` (every file in `scripts/` is named `<id>__<name>`). An app is `scripts/<id>__config.json` plus `scripts/<id>__fixtures.json`. Nothing else is edited.

**The engine is kept once.** Its source is `kit/python/bolt_app_engine.py` in the toolkit. `./bolt-apps new <template> <id>` makes an app (thin is the default; `--full` keeps a private copy) that holds a short entry in `scripts/<id>__engine.py` (about 25 lines, the same for every app, never edited) that loads it; `./bolt-apps check`, `run` and `regen` find the engine themselves, and `./bolt-apps pack` writes it into the pack once, as `scripts/<id>__bolt_app_engine.py`, so the pack still carries everything the app runs (Bolt 181 has no shared engine, and every Bolt installs scripts into one folder). The command in the app file names that file too, so changing it asks the person to approve again. After editing a thin app's config, regenerate its app file with `./bolt-apps regen <app folder>` (the `python3 scripts/<id>__engine.py --emit-yaml` line below is for an app that holds its own copy: a thin entry finds the engine through the toolkit). An older app that still holds its own full copy of the engine in `scripts/<id>__engine.py` keeps working unchanged. `./bolt-apps upgrade-kit <app folder>` (or `--all`) moves it to the thin entry: it replaces only that file and regenerates the app file (the command now also names the engine file), and it refuses, changing nothing, when the copy is not byte for byte the known engine or the app file was edited by hand. It is safe to run again. Do not copy the engine into an app; if the engine lacks something, ask for it in the toolkit. Regenerate the app file after any change:

```
./bolt-apps regen <app folder>
```

(An app that holds its own engine copy can still run `python3 scripts/<id>__engine.py --emit-yaml > utilities/<id>.yaml` by hand.)

If the config is wrong (an unknown icon, a missing key, unreadable JSON), `--emit-yaml` prints the problem on screen (for an icon it also lists the valid names), writes nothing to stdout and exits 1. A line break in a value the app file holds (the app title or description, a form input, a lookup example, a widget, a field label) is such a problem too: the app file keeps each value on one line, so the message names the config key to rewrite. The shell still creates an empty `utilities/<id>.yaml` for `>`: an empty file means the command failed, so run it again without `> ...` to read the reason. `run`, `lint` and `check` say the same when they meet an app file that is empty or is not YAML.

The engine never connects to anything unless `api.fixture_default` is `false` (or `BOLT_APP_FIXTURE=1` is unset and the config says live).

## Modes (`mode`)

| mode | Use it for | Needs |
|---|---|---|
| `views` (default) | Overview tiles that drill into lists, detail views, filters | `endpoints`, `overview`, `views` |
| `form` | A typed input form, then a result pane | `form` |
| `lookup` | One word in, one detail card out | `endpoints`, `lookup` |

## Two shapes of app: lookup or views

Pick before you build: the two shapes cannot be mixed in one app.

| | `lookup` | `views` |
|---|---|---|
| The person types | a word (up to three): `=chip serde` | a view name, then optionally one word: `=chip customers acme` |
| The word reaches | the API, as `{query}` in an endpoint path (URL-quoted) | nothing remote: it filters the list the endpoint already returned |
| Drill and Back | none | yes (`nav` rows, `children`, Back row) |
| Right pane | one for the result | one per view, from `views[].widget` |
| Buttons on a row | Open (`url`) and Copy; see "Buttons in lookup mode" | Open and Copy in config; more in the app file's `actions:` |

What a views-mode app does with a typed first word, from the engine and the launcher (written from source, run here only in sample mode): a first word that is not a declared view is not an error, but the engine ignores it and prints the overview rows, which the app-level right pane draws. So a views-mode app cannot take a typed query. What it can take: `=chip <view> <word>` keeps the rows of that view whose title, subtitle, badge or first five fields contain the word (case-insensitive, one word; a "Showing N of M" row clears it), and `=chip <view> <id>` opens one row when that view has `children`.

**Recipe: type a name, see a summary, drill into related lists (views mode).** It works when the API's list endpoints already return every row you need (the engine filters on this side, up to the row limits in the rules table):

```
"endpoints": { "customers": { "path": "/customers" }, "orders": { "path": "/orders" } },
"views": [
  { "id": "customers", "title": "Customers", "endpoint": "customers",
    "children": [{ "view": "orders", "match": "customer_id" }],
    "item": { "title": "{name}", "subtitle": "{plan} · {city}", "fields": [{ "label": "Plan", "value": "{plan}" }] } },
  { "id": "orders", "title": "Orders", "endpoint": "orders",
    "item": { "title": "{number}", "subtitle": "{total|round2} · {status}" } } ]
```

The person types `=chip customers acme`, sees the customers that match (each row is a summary), presses Enter on one to see its summary with its orders listed below, and Back returns to the filtered list. The portal-template example is this shape (projects, each with its tickets).

**Not possible in one app on 181:** "type a name, ask the API for exactly that name, then drill". Asking the API per word needs `lookup`, and lookup has no drill. The honest workaround is two apps: a `lookup` app for the typed name (rows, Open, Copy) and a `views` app for browsing (its own chip), or a script app that reads its own words (see `repo-radar`, and "Typing free text and views in a script app" below).

## `app`
`id` (folder name), `chip` (the word typed after `=`), `title`, `icon` (a launcher icon name), `description`, `service` (name used in error rows), `noun` (what one typed word names, such as crate: a 404 shows "No such crate"; without it the row says the lookup's `none_title`, default "No match"), `searchable` (accepted and does nothing: once the app has rows, Bolt filters them as you type, matching the title and subtitle only; an app with `dispatch.choices` shows its confirm choices instead), `timeout` (seconds, 1 to 60).

## `api` (views and lookup)
`on_missing_key` (`setup` or `sample`; see "Three starting states" below), `base_url` (https, or loopback http for tests; required unless the app is sample-only: `api.fixture_default` true, or no `api` section at all), `key_env` (variable name), `env_file` (a `.env` path, must be `chmod 600`), `auth_header`, `auth_prefix` (`"Bearer "`), `fixture_default` (true = sample data, no network), `fixture_file`, `fixture_banner` (show a Sample data row). `allowed_hosts` (extra https hosts an endpoint `path` may name; the key is sent only to the `base_url` host), `auth_in` (`header`, the default, or `query`), `auth_param` (the query parameter name for `auth_in: query`, default `api_key`; the key is stripped from every answer before it is cached or shown, so prefer a header when the API allows one), `user_agent`.

## `cache`
`ttl` seconds a result is fresh (a repeat run inside it makes no request), `stale_max` seconds an old copy may be shown when the API fails. A failed call is never cached and never shown as zero: a view whose list did not load and has no old copy shows one "Could not read <view>" row (Enter retries), not an empty list. A detail shows the same row for each linked list that did not load, beside the linked rows that did. A copy holds the unwrapped, mapped rows and is tied to the configuration that produced them. The cache keeps whole lists or records where the config reads them and cuts other list rows to the fields the config uses. If trimming drops every field of a matching lookup record, the next run still knows the step matched. When an answer is still over the kit cache's 1 MB, a later failure says there is no old copy and why. An answer over 5 MB is not read and shows "<service> sent more than 5 MB, more than this app reads" instead of "returned an error".

## When the API answers 404
An HTTP 404 (or 410) on EVERY call of a run, with nothing else to show, means the service is up and has no such thing. The app then shows one row with the typed word in its subtitle and no Retry: "No such <app.noun>" when `noun` is set; in lookup mode "No match" (or the lookup's `none_title`); in views mode without a noun, "The service answered 404 for <endpoint names>". It is never shown as an outage, and an old copy is never shown for it. When only some calls answered 404 and others worked, the data that loaded is kept and a notice says "Some data did not load: <endpoint> answered 404". A 404 mixed with another failure shows the other failure (offline, rejected key, rate limit, "returned an error" for a 5xx). In a chained lookup only the first step, the one that takes the typed word, can say "No such"; a later 404 reads "Found it, but the next lookup answered 404". `demo-notfound` previews the row in sample mode.

## `endpoints`
`name: { path, kind (list or object), data (where the rows sit in the response, default "data"), map }`. `map` renames fields: `{ "title": "name", "owner": "assignee.name" }` (dotted paths work). Fixture mode reads `fixtures.json[name]`, the raw response. `fixtures.json` may also hold `_now` (epoch seconds: a fixed clock for the date tokens in sample mode) and, for a form app, `seed` (sample rows shown after the saved ones).

More endpoint options: `hydrate` (`{ path, limit }`: the answer is a list of ids and `path` contains `{id}`; one request per id runs in parallel, `limit` 1 to 50, default 20; an id that fails is dropped; if none answer the endpoint fails), `flatten` (`true` or a field name: an object of lists keyed by date or name becomes one list, the key kept in that field, default `key`), `require` (on an object endpoint: dotted paths that must be present, otherwise the answer counts as failed, never as zero). A `path` may use the date tokens `{today}`, `{today-7d}` and `{today+1d}` (local dates, 0 to 9999 days). An answer that says there is more (a next link or cursor, `has_more`, or a total above the rows held; read from the answer, `meta` or `pagination`) shows a "first page only" notice.

## `stats` (named numbers for the overview)
`{ endpoint, where, group }` counts rows. `where`: `{ "status": ["done"] }`, `{ "status": { "not": ["done"] } }`, `{ "n": { "gte": 1 } }`. `group` gives "7 a, 3 b". A plain value in `where` means equals and works for booleans and numbers too (`{ "done": true }`, `{ "n": 3 }`); a list means any of; a comparison object such as `{ "n": { "gte": 1 } }` compares numbers (also lte, gt, lt); any other operator name (such as between) is a config error that names the allowed ones. Equality is type-strict: `{ "neg": "-2" }` does not match the number -2, and `{ "d.x": 7 }` does not match the text "7"; write the value the way the API sends it. `{ "pct": [a, b] }` and `{ "sum": [a, b] }` combine other stats.

Totals over a field: `{ "endpoint": "tickets", "field_sum": "hours" }` adds the field over the rows (after `where`), `{ "endpoint": "tickets", "field_max": "hours" }` takes the largest. A value that is a number or a numeric string counts ("2e2" is 200; "1,000" is not a number and is skipped, as are "inf", "nan", "1e999" and a JSON Infinity: never a crash); a row with no number in the field is skipped; when no row has one, the stat is left out (a row template that uses it shows "unknown", never 0). `where` and the field name take a dotted path. When a stat has `field_sum` or `field_max`, `group` is ignored. The other stat forms (`pct`, `sum`) take stat names, not fields, so total a field first and combine the stats. Example:

```
"stats": { "hours_all": { "endpoint": "tickets", "field_sum": "hours" },
           "hours_open": { "endpoint": "tickets", "where": { "status": ["open"] }, "field_sum": "hours" },
           "longest": { "endpoint": "tickets", "field_max": "hours" },
           "open_share": { "pct": ["hours_open", "hours_all"] } }
```

## `overview.rows[]`
`title`, `subtitle`, `icon`, `body`, `view` (drill to a view; `arg` filters it), `url` (opens a link), `tile`, `extra`, `trend` (list of numbers), `only_if`. `overview.widget` replaces the default tiles pane.

## `tile`
`{ label, value (a stat or field name, or a number), max, unit (4 characters), note, foot, badge }`. `badge` is a word or a list of `{ "if": "ready>=80", "badge": "ON TRACK" }` rules, first match wins, last one without `if`. A value that cannot be read gives no tile, and its badge comes only from rules with an `if` on another field: `status==open` still applies, while the last rule without `if` and every rule that has the value's field on its left, or reads that field on its right (ordering operators also skip its name when absent; == and != keep the absent name as plain text), are skipped, so a count that did not load is never called CLEAR and a text such as N/A never meets `remaining>=10`. A plain word badge is left out.

## `views[]`
`id` (view count: see [the rules table](QUICKSTART.md#4-the-rules-table)), `title`, `icon`, `endpoint`, `sort` (`[{ field, order[], desc }]`), `children` (`[{ view, match }]` drills to rows of another view whose `match` field equals this row's id), `no_children`, `empty`, `widget` (`{ kind, mode, bind }`, copied into the app file; default is a detail preview built from `item.fields`). Pane kinds with app data: card, markdown, entity_preview, chart, table, cards, detail, json_tree, diff, image_grid, heatmap, gauge (the same list as the rules table; chart types are in its Chart types row, and the pie, donut, area, series, heatmap and gauge panes need Bolt 182).

More view options: `id_field` (the row field that holds its id, default `id`; an id made of letters, digits, underscores, dots and hyphens and at most 64 long is the row's drill arg as it is unless it ends in a dot and 12 lowercase hex digits; those ids and any non-token id drill by an ASCII form plus a short hash of the whole id), `pane_id` (the pane name the rows use, default the view id), and on a `children` entry `parent_field` (the row field compared to `match`, default the view's `id_field`).

`item`: `title`, `subtitle`, `icon`, `url`, `body` (markdown), `copy`, `tile`, `fields` (up to 5 `{ label, value, kind }`), `extra` (named row fields a widget binds as `{{row.name}}`; a value that is exactly `{field}` keeps a number a number), `data_field` (a nested object for a json_tree pane), `trend_field`. A field named `left`, `right` or ending `_lines` keeps line breaks.

Templates use `{field}` and `{field|filter}`: `human`, `day`, `hhmm`, `when` (an epoch in seconds or milliseconds as local `2026-11-15 14:05`), `whenday` (the same, date only), `round`, `round1`, `round2` (a number to 0, 1 or 2 decimals), `upper`, `lower`, `yes`, `join`, `dots`, `count`, and any name from `maps`. A missing value reads `unknown`.

What each filter takes and gives:

| Filter | Input | Output |
|---|---|---|
| `when` | an epoch in seconds or milliseconds (a number or digits), or an ISO date string (checked as a real calendar date and time) | `2026-11-15 14:05` (local time) for an epoch; an ISO string `2026-07-18T09:30:00Z` gives `2026-07-18 09:30`, as written, with no time zone change; an impossible date such as 2026-02-30 or 2026-13-45 reads `unknown`, and so does an eight-digit string such as 20260718 (neither an epoch nor an ISO date) |
| `whenday` | the same | the date only, `2026-11-15`; ISO strings work, so a crates.io or GitHub date needs no other filter |
| `day` | any text that starts with a date | its first 10 characters (`2026-07-18`) |
| `hhmm` | an ISO date-time | characters 12 to 16 (`05:30`) |
| `yes` | a true or false value, or the text true, false, yes or no in any case | Yes or No (it never prints blank, so a missing flag reads `unknown`; show a flag only on rows where it matters) |
| `thousands` | a number or digits | `1,720,732,933`; with decimals `1,234.50`; not a number reads `unknown` |
| `round`, `round1`, `round2` | a number | 0, 1 or 2 decimals, half up |
| `human` | text | in_progress becomes In progress |
| `upper`, `lower` | text | the case changed |
| `join`, `dots`, `count` | a list | chips, ` · ` separated text, the length (`1 point`, never `1 points`) |

A `tile` value must be a number (a text value draws a `-` tile), but a tile `label`, `note` and `foot` are templates: put text such as a version in the label (`"Latest {crate.max_stable_version}"`). Numbers in a tile get no separator; put the formatted number in the row title or subtitle with `thousands`.

## Words typed after the chip (views mode)
`=chip view`, `=chip view <id>` (detail; an id of 57 to 64 characters has no forced refresh, so its Reload row reads the failed calls again and takes the rest from the cache), `=chip view <word>` (filter by that word; any word works, `C++` or `a/b` too, and its Retry rows reload the list without the filter), `=chip view demo-offline | demo-stale | demo-auth | demo-nokey | demo-notfound` (preview the error rows in fixture mode). A view whose widget `mode` is `list_data` (chart, table) shows only its data rows, so nothing but data is plotted.

## `form`
`inputs[]` (`name`, `type` text, number, date, select or toggle, `label`, `required`, `default`, `placeholder`, `options`, `min`, `max`, `step`, `max_length`, `pattern`), `submit.label`, `store.file` (a local log, kept `0600`; `max_rows`), `record` (what is saved, templates over the input values; an empty input is saved as empty text, not `unknown`), `item` (how a saved row becomes a result row), `widget`. Bad input shows one "Not saved" row and saves nothing.

## `lookup`
`endpoint`, `match` (fields compared to the typed word: exact first, then contains), `item`, `widget`, `prompt_title`, `prompt_subtitle`, `none_title`, `examples`.

### Buttons in lookup mode
A lookup row has Open (when its `url` renders to an https address) and Copy, and nothing else: no nav, no drill, no Back, no per-row actions. What Copy puts on the clipboard depends on the form of the lookup:
- `endpoint` + `match` + `item` (one endpoint): `item.copy` (a template) is honoured; with none, Copy copies the row text.
- `steps` + `rows` (a chain): each `rows[]` entry is drawn like an overview row, so its `copy` is ignored and Copy copies the row text. The check command warns about it (config_copy_ignored). Put the text you want copied in `title` or `subtitle`.

## Files named in the command
The app file lists `<id>__config.json`, `<id>__fixtures.json`, `<id>__bolt_app_kit.py` and, for a thin app, `<id>__bolt_app_engine.py` after the script, so Bolt includes them in what the person approves and asks again if any changes. The engine ignores them as input.

## Commands

```
./bolt-apps kit vendor --flat kit/examples/<id>     # once, and after a kit update
./bolt-apps check kit/examples/<id> --update-golden # review golden/ once
./bolt-apps check kit/examples/<id>
./bolt-apps lint kit/examples/<id> --personal
./bolt-apps pack kit/examples/<id> --personal --version 1.0.1   # a higher version each time
```
Run `./bolt-apps keygen` once before the first pack (it makes your signing key and never overwrites one). Drop the `.boltpack` on the Bolt launcher or Bolt Apps.

## Where to store keys (measured against the launcher)

Bolt starts a personal app's script with an empty environment except a short allowlist (listed in [the rules table](QUICKSTART.md#4-the-rules-table), from `schema/bolt-rules.json` `runner_env`). A name that looks secret (it contains TOKEN, KEY, SECRET, PASS, PWD, CRED, AUTH, PRIVATE, SESSION or COOKIE) is never forwarded to a personal or packed app, and `bridge.env` is refused if it lists one; only apps shipped inside Bolt may forward them. So an environment variable in your shell does NOT reach the script when Bolt runs it. It works only in a terminal and in tests.

| Place | Works in Bolt | Good | Bad |
|---|---|---|---|
| System keychain (macOS `security`, Linux `secret-tool`) | yes | encrypted at rest, per user, never a file | not available on Windows here; needs the tool installed |
| `~/.config/<app id>/.env`, mode 0600 | yes (the script runs as you and can read it. The install checks do not require a declared permission for this, but list `files` in `bolt-app.json` so the listing is honest) | works everywhere, one line to set up | plain text on disk; the engine refuses it if others can read it |
| Environment variable | terminal and tests only | handy for CI | never reaches the script under Bolt |
| `inputs: type: secret` form field | accepted by the launcher; not used by these examples | typed once | the value is passed to the command as a word; not measured for the run log, so do not rely on it |

The engine (and any kit app) reads the key with `kit.get_secret(app_id, NAME, env_file=...)`: environment, then keychain, then the `.env` file. When nothing is found it shows a row with the exact one-line setup (`kit.setup_hint`). A key that is found but refused (the file is a link, belongs to another user or others can read it; the key is too short) and a key file that gives no key (it cannot be read, its line is empty, written another way or missing) each get a row that names that cause, the file `env_file` points at, and the fix for it. `kit.redact(text, [key])` removes the key, `user:password@` in an address and key-like query values from any text before it is shown.

Never put a key: in the app file, in `config.json`, in `fixtures.json`, in a pack, in the cache, in a query word, in row text, in an error message, in a URL you show or log. The runner also masks the values of names it forwards, but a script that reads its own key is on its own: use `redact`.

Expected install-prompt finding: an app that reads the keychain is listed as "the system keychain or the security command". That is true, so it is left in.

## More options
- `lookup.steps` + `lookup.rows`: a chain of endpoints; a step's `path` may use `{query}` and `{earlier_step.field}` (the first result of an earlier step), values are URL-quoted. An endpoint `path` that starts with `https://` is used as is (a second host). The steps run one after another inside one time budget of 14 s for the whole run, so a slow chain ends with "<service> did not answer in time" instead of outlasting the bridge timeout.
- `maps`: `{ "wmo": { "0": "Clear" } }`, used as `{field|wmo}`. Filter `hhmm` cuts `2026-01-01T05:30` to `05:30`.
- `trend_path` on an overview or lookup row: a dotted path to a number list for a tile sparkline.
- Stats `{ endpoint, field_sum }` and `{ endpoint, field_max }` total or maximise a field.
- `api.key_env` is optional: leave it out for a keyless API. `api.user_agent` sets the User-Agent header.
- A chart or table view (widget mode `list_data`) has no Back or refresh rows.
- A tiles view (cards, `bind.layout: tiles`) draws a tile for every row, a Back or refresh row included, so a bare one is an empty "no value" tile and the checker refuses it (rule tile_row_without_value). Give the refresh row a number (the script-template overview uses `Data age` in seconds), or keep Back and refresh rows in a view that is not a tiles grid.
- The first row of a drilled list is selected when it opens, so the Back row is the first thing the right pane draws: give your Back row a pane text. In a view whose pane binds fields (detail, card, diff, json_tree) a row with none of them draws dash placeholders. The engine handles it: when any view has such a pane, the app file gets a small `note` markdown view and the Back, Refresh and notice rows of those views use it (`pane: note`, with a body). A script app does the same with `kit.back_row(subtitle, view=kit.NOTE_VIEW)` and `kit.note_row(...)` and declares the `note` view. check fails (pane_blank_row), Back and Refresh included, any row of such a view that binds none of its fields, and any row whose pane names a view that binds none of the row's fields. If the author already has a view named note, the engine names its own back-note.

## What backs your app (the coverage matrix)

| Backing | Runtime | How | Start from | Limits |
|---|---|---|---|---|
| CLI command | `bridge` | a script runs the command as an argument list, no shell | `cli-wrapper-template`, `system-glance` | personal pack only; per-OS command table; stderr is not seen; 60 s at most |
| Remote HTTP API | `bridge` | a script calls the API inside a deadline; one config-only API through this engine | `repo-radar`, `around` (several joined), `lookup-template` and the engine apps (one API) | declare `network`; keys from keychain or `~/.config/<app>/.env` |
| Local HTTP service | `http_local` | one GET or POST to loopback, no script | `local-service-template` | loopback only, one request, no secrets, no chaining |
| File | `bridge` | a script reads a typed path with caps | `file-insights-template`, `form-template` | declare `files`; a path cannot travel in a row's nav arg, so keep the last path in the kit cache |
| MCP server | none native | a bridge script starts the server over stdio (below) | the snippet below | tested only against a stand-in server |

These examples are not driven by `engine.py`: `file-insights-template`, `cli-wrapper-template`, `repo-radar` and `around` each have their own script on the same flat kit, with `config.json` holding what changes (columns, command table, weights, TTLs) and `--emit-yaml` generating the app file. Their entries in `index.json` say `custom script on the flat kit`.

Launcher facts measured for these examples: pane kinds and limits are in [the rules table](QUICKSTART.md#4-the-rules-table) (a place opens with an Open in Maps URL action, not a map pane); the chart title is the `label` bind written as literal text; a nav arg is one plain token, so repeat the typed query from the kit cache; the bridge command must name every helper file as `{{scripts_dir}}/<file>`.

## MCP: the workaround script

Bolt has no native MCP runtime for a personal app. A `bridge` script can stand in: start the server the person already has installed, speak JSON-RPC over its pipes, call one tool, and print rows. It was run against a stand-in stdio server that answers `initialize` and `tools/call`; it has not been run against a real MCP server, so treat it as a starting point. Put `{"server": ["npx", "-y", "some-mcp-server"], "tool": "search", "arg": "query"}` in `scripts/<id>__config.json`, declare `runs_commands`, and name `config.json` and `bolt_app_kit.py` in the bridge command.

```python
import json, os, subprocess, sys, threading
import importlib.util as _u
_me = os.path.basename(__file__); _pfx = _me.partition("__")[0] + "__"     # <app id>__ : every file of this app starts with it
_s = _u.spec_from_file_location("bolt_app_kit", os.path.join(os.path.dirname(os.path.abspath(__file__)), _pfx + "bolt_app_kit.py"))
kit = _u.module_from_spec(_s); sys.modules["bolt_app_kit"] = kit; _s.loader.exec_module(kit)
cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), _pfx + "config.json")))

def main(argv):
    word = " ".join(w for w in argv[1:] if w != "-" and not w.endswith(("config.json", "bolt_app_kit.py"))   # the helper files named in the command)[:200]
    if not word:
        kit.emit([kit.row("Type a query", "sent to the %s tool" % cfg["tool"], copy=False)])
    exe = kit.which(cfg["server"][0])
    if not exe:
        kit.emit([kit.error_row("%s is not installed" % cfg["server"][0], title="MCP server not found")])
    p = subprocess.Popen([exe] + cfg["server"][1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    threading.Timer(15, p.kill).start()        # a hung server must not hold the launcher
    def rpc(i, method, params):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
        while True:
            line = p.stdout.readline()
            if not line:
                raise RuntimeError("server closed")
            m = json.loads(line)
            if m.get("id") == i:
                return m
    try:
        rpc(1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "bolt-app", "version": "1"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
        r = rpc(2, "tools/call", {"name": cfg["tool"], "arguments": {cfg["arg"]: word}})
    except Exception as e:
        kit.emit([kit.error_row("The MCP server did not answer (%s)" % e.__class__.__name__, title="MCP call failed")])
    finally:
        p.kill()
    texts = [c.get("text", "") for c in (r.get("result") or {}).get("content", []) if c.get("type") == "text"]
    kit.emit([kit.row(t.splitlines()[0][:100] if t else "(empty)", "tool %s" % cfg["tool"], body=t, icon="Terminal") for t in texts]
             or [kit.error_row(str((r.get("error") or {}).get("message", "no content"))[:120])])

main(sys.argv)
```
Limits: servers that need a login or a key are out of scope here (use `get_secret` and pass the key in the server's environment from the script, never in `config.json`); the server starts on every run, so slow servers feel slow; remote MCP servers over HTTP are a plain HTTP call and need no workaround.

### Scoped and slashed names (`@types/node`)
Every `{query}` and `{earlier_step.field}` in an endpoint `path` is percent-encoded as one path segment, with nothing left unescaped: `@types/node` goes out as `%40types%2Fnode`, so the `/` does not add a path level. A test runs a real lookup against a local server and checks the request line `/%40types%2Fnode/latest` (`kit/python/tests/test_cold_run2_engine.py`). What this proves: the engine sends exactly that. Whether a given service accepts `%2F` is up to the service: the npm registry answered `@types/node` this way in a live run by the author of pkg-peek; a service that wants a literal `/` or `@` cannot be reached with `{query}` in the path, so put the name in a query string (`?name={query}`) when it allows that. A query is at most three typed words, joined with a space (`%20`). A query that is only `.` or `..` is sent as `%2E` or `%2E%2E`, so a server or proxy cannot resolve it as a dot segment. Filters (`|name` in a row template) act on the answer text, not on the typed word, so nothing in a row template re-encodes a name: write the Open link as `https://www.npmjs.com/package/{latest.name}` (the name as the API returned it, `@types/node` stays readable).

### Recipe: a text-only lookup result (no tile)
A lookup whose answer is words (a version, a status, a description) has no number to put in a tile. Use an `entity_preview` selected-row widget, not a tiles grid. `tiles_above` draws only for a row that has a number, so a row with no `tile` draws no empty "-" tile, and the row's `body` (markdown) is what the pane shows:

```
"lookup": { "rows": [
  { "title": "{latest.name} {latest.version}", "subtitle": "latest version", "body": "## {latest.name}\n\n{latest.description}", "url": "https://www.npmjs.com/package/{latest.name}" } ],
  "widget": { "kind": "entity_preview", "mode": "selected_row", "bind": { "title": "{{row.title}}", "subtitle": "{{row.subtitle}}",
    "tiles_above": { "title": "{{row.kpi_label}}", "value": "{{row.kpi_value}}", "unit": "{{row.kpi_unit}}", "max": "{{row.kpi_max}}", "trend": "{{row.trend}}", "subtitle": "{{row.kpi_note}}", "badge": "{{row.kpi_badge}}", "footer": "{{row.kpi_foot}}" },
    "body": "{{row.body}}", "actions": ["open", "copy"] } } }
```

Give a row that has a number a `tile` and it draws one above its text; give every text-only row a `body` (its pane shows title, subtitle and body; a row that binds none of the pane's fields is `pane_blank_row`). A plain `markdown` widget (title, subtitle, body) is the same without tiles. lookup-template is this shape: tiles on the temperature rows, plain text on Coordinates and the forecast link. check treats a tiles grid (`cards` with `bind.layout: tiles`) over rows without numbers as an error (`tile_row_without_value`); the `known_empty_tiles` waiver is gone from lookup-template.

## An app that only shows sample data (offline, no API)

Most apps ship live (`api.fixture_default` `false`). An app that is sample-only by design (a demo, a reference card, a checklist whose data you write yourself) ships with the sample switch on, so it never opens a connection:

```
"api": { "fixture_default": true, "fixture_file": "fixtures.json", "fixture_banner": true }
```

- `base_url` may be left out when `fixture_default` is `true`, and the whole `api` section may be left out (then the app is sample-only, and `fixture_file` is `fixtures.json`). Keep a name that cannot resolve, such as `https://example.invalid`, if you want the section for readers. Nothing connects to it.
- A sample-only app draws no Refresh row: it never fetches, so there is nothing to refresh.
- `fixtures.json[<endpoint name>]` holds your rows, shaped like an API answer. It is signed with the pack, so changing the data means reshipping.
- Leave out `key_env`: no key, no setup row. `on_missing_key` does nothing here.
- `fixture_banner` (default off) adds a row or tile note that says the data is sample. Turn it on when the person might take your rows for real data. The text is for the people who use the app ("This is sample data."), never an instruction to edit `config.json`; the author-facing hint is in the output of `bolt-apps run` and `doctor`. Label real-looking rows yourself too (a `SAMPLE` badge, "invented" in the body) if they could be mistaken for facts.
- `ship` and `doctor` read the same words: "Start mode: sample data (api.fixture_default is true), so it never contacts a service." If the same config also names a `key_env`, both add that the key is never read and the app never goes live.
- QUICKSTART rule 4 ("ship live") has this one exception: sample-only by design. If the app is meant to show someone's real data, `fixture_default` must be `false`.

## Sample mode, live mode and what check does

- A shipped engine app is live (`api.fixture_default` is `false`) unless it is sample-only by design (see "An app that only shows sample data" above). An installed pack cannot be switched between the two, because `config.json` is signed and Bolt starts the script with no environment.
- `check` runs the script in sample mode so tests need no key and no network: put `"fixture": true` at the top of `check.json` (every case) or on one case (a case wins over the top level; `"fixture": false` forces live). The script then reads `fixtures.json`. A terminal run can use `BOLT_APP_FIXTURE=1` (or `0`).
- Live with no key shows one setup row with the exact one-line command. Live with the network down shows the offline row, or an old copy with its age when one was cached. These are checked in sample mode with `demo-nokey`, `demo-offline`, `demo-auth` and `demo-stale`.

## Make it yours (the files `new` leaves)

`./bolt-apps new <template> <id>` copies a working app, renames it and makes `check` pass on its sample data. It does not know what your app is for, so these files still describe the template until you rewrite them:

| File | What `new` leaves | What to do |
|---|---|---|
| `scripts/<id>__config.json` | the template's endpoints, views, rows; `app.description` says TODO | rewrite for your API (this file is the app) |
| `scripts/<id>__fixtures.json` | the template's recorded answers | replace with answers from your API (trim them), or your own sample rows |
| `check.json` | engine apps (views or lookup): one case per view or typed word, no expected text, no goldens. Other templates: the template's cases | add a case per view you add; add `expect.text_present` words your app prints; add `"golden": "golden/<name>.json"` to a case and run `check --update-golden` once your data is final |
| `README.md` | a first line saying "Template text below"; the rest is the template's | rewrite it, delete the note |
| `bolt-app.json` | `title` from the id; `summary`, `role`, `saves` say TODO (lint warns `listing_todo`) | one real line each; `permissions` are the real ids the template needs, check them |
| `utilities/<id>.yaml` | generated from the config | regenerate after every config change: `./bolt-apps regen <app folder>` |

The TODO description is shipped: `utilities/<id>.yaml` carries `app.description` into the pack and the launcher shows it. `lint`, `pack --personal` and `ship` print `description_todo` and `listing_todo` as warnings (not errors: the pack still builds), and `ship` adds a plain line saying the description still says TODO. Rewrite it before you share the pack.

`check` also fails any case, whatever it expects, when the run prints no rows, a row has no title, a row of a shared-engine app has an empty or missing subtitle, a sample-labelled app shows no row that says "sample", or the case names a view the config no longer has (`case_unknown_view`: the engine would draw the overview and the case would test nothing; `expect.view_fallback: true` marks a case that tests that fallback on purpose). `expect.min_rows` sets a floor on the rows.

The generated `check.json` proves that your app runs and draws well-formed rows (at least one row per case, titles, subtitles, a sample label); it does not prove your data is right. One useless row per case, or emptied fixtures, still pass.

Checklist step: when your data is final, run `check <dir> --update-golden` once (after adding `"golden": "golden/<name>.json"` to the cases you want compared); from then on check compares your real output.

When `check` fails after an edit because an old expectation no longer holds, it names `check.json` and the case, and ends with one hint: change `cases[].expect.text_present` to words your app prints (or delete the line), then run `check --update-golden` once your data is final and read the goldens it rewrites.

## What check tells you

- `expected_text_missing` now prints the first rows that were found, so you can copy the real text.
- If the script printed its own error row ("This app is not set up correctly", "This app could not run"), `check` reports `app_error_row` with that row's text, for example a bad icon name in `config.json`, before it looks at expected text.
- Every `icon` in `config.json` (the app, overview rows, views, items) must be a name in `kit/schema/icons.json`. The engine refuses an unknown name with its place (`views[0].icon`), and `lint --personal` reports `icon_unknown`: an error for `scripts/<id>__config.json` (the kit refuses the row) and a warning for the app file's own `icon:` (the launcher draws a plain plug and still shows the app).
- A file in `golden/` that no case names is `golden_stale`. A copied template brings its goldens: keep the cases you want, delete the other goldens, then run `check --update-golden` once and read the files.
- Stubs can answer by argument, so a tool called as `git status` and `git log` can be tested: `"stubs": {"git": {"stdout": "default", "by_args": [{"args": ["status", "--porcelain"], "file": "fixtures/macos/status.out"}, {"args": ["log"], "stdout": "abc123 first", "rc": 0}]}}`. The first rule whose words equal the first words of the command line answers; the stub's own `stdout` or `file` is the default. A case can set environment variables with `"env": {"MYVAR": "value"}` (names in capitals; `PATH` is always the stub folder and `HOME` a temporary folder).

## Permissions: which list wins

`bolt-app.json` `permissions` is listing text. The install prompt and `verify` show the permissions computed from the app files (`runs_commands`, `inserts_text`, `opens_links:<host>`, `network:localhost:<port>`). A declared `network` or `files` for a bridge script is never computed, shown or checked. `lint --personal` warns with `permissions_differ` when a computed word is not declared; the warning names those words and also any declared words that are not computed. Keep a declared word only if it is true of the app.

## Limits of views mode (so you pick the right template)

- Views mode calls the list endpoints you name; it cannot call a per-id detail endpoint. `{id}`-style paths (and `{query}`) work only in `lookup` mode, where one typed word drives the calls. For a detail view, put the detail fields in the list response, or use a `lookup` app, or write a script like `repo-radar`.
- Row actions in config are only Open (`url` on an item) and Copy (`copy`). More buttons need the app file's `actions:` (kinds `url`, `composer`, `utility`, `run`; the count limit is in [the rules table](QUICKSTART.md#4-the-rules-table), and Open and Copy count), and a nav row carries no actions.
- Stitching: stats from several endpoints on the overview, and `children` that list rows of another view whose field equals this row's id. There is no cross-join of two endpoints into one row. For that, use a script (`repo-radar` joins on a repo and its package; `around` stitches by distance).
- Lists are capped by the engine (row limits: [the rules table](QUICKSTART.md#4-the-rules-table)); the view says so.

## Which file to edit in each template

The `edit` list of each template in [index.json](index.json) is the one answer (a test checks the files exist). A template with no `edit_in_script` entry needs no script change. For a CLI app you are expected to edit `build()` in `scripts/<id>__wrap.py`, because the rows depend on what your tool prints. `scripts/<id>__fixtures.json` holds a sample so a copy works before the tool is installed.

Never edit `<id>__bolt_app_kit.py`: re-vendor it with `bolt-apps kit vendor --flat <app>`. Every file in `scripts/` is named `<id>__<name>`: all installed apps share one scripts folder, and Bolt refuses a file another app already owns (`owned_by_other`). Every script that lists a helper file in its command names it as `{{scripts_dir}}/<id>__<file>` (`<id>__config.json`, `<id>__fixtures.json`, `<id>__bolt_app_kit.py`) so Bolt shows it in the approval.

## Hero picture (Bolt 182)

The `entity_preview` pane can draw the selected row's picture full width above the tile and title (newer than 181). `bind.hero` is a map: `src` (required), `alt`, `caption`, `credit`. `image_url` is unchanged: a 40 pixel avatar.

```yaml
right_widget:
  kind: entity_preview
  mode: selected_row
  bind:
    hero:
      src: "{{row.img1}}{{row.img2}}{{row.img3}}"
      alt: "{{row.hero_alt}}"
      caption: "{{row.hero_caption}}"
      credit: "{{row.hero_credit}}"
    title: "{{row.title}}"
    body: "{{row.body}}"
```

- The pane draws the picture at the full pane width, aspect kept, at most 360 px high, in a rounded frame, with the caption as a pill and the credit as a small line, then the tile, title, subtitle, fields, body and actions.
- `src` must expand to an inline `data:image` URI (png, jpeg, gif, webp, avif or bmp, at most 1 MiB). A web address is blocked: the script fetches the picture and puts it in the row. A missing or invalid `src` draws no hero and the pane is as it was.
- `alt`, `caption` and `credit` are at most 200 characters; `src` is at most 4096 characters and joins at most 16 `{{ }}` references.
- A row text field is cut at 4,000 characters, so the picture is split over `img1`, `img2`, ... and `src` joins them. 16 parts is about 47 KB of picture. The kit does the split: `kit.hero_fields(bytes_or_data_uri)` returns the `imgN` fields and `kit.hero_src_template(n)` the `src` text. It refuses a picture over 1 MiB, one that is not png, jpeg, gif or webp (Bolt also takes avif and bmp, but the standard library cannot recognise or resize them, so the helper refuses avif and bmp bytes: pass a `data:image/avif;base64,...` string instead and it is trusted and split as it is) and one that needs more than 16 parts; in that case use a smaller picture (the standard library cannot resize, so hand it a small one; ask the picture host for a small size, or draw it small). Catch `kit.KitError` and send the row without the picture fields: the row still shows, with no hero.
- Pane keys are read per Bolt version. **A Bolt 0.1.181 refuses the whole pack when one app uses `hero`** (`presentation.right_widget.bind.hero: unknown key for a entity_preview pane`), so no app in the pack installs; a local `schema_version: 1` file only warns and shows no hero. So an app that uses `hero` sets `"min_bolt_version": "0.1.182"` in `bolt-app.json`, and you give the pack only to people on Bolt 182 or newer. `lint`, `check` and `pack` fail an app that uses `hero` without it, with the message "needs Bolt 182". Bolt does not read `min_bolt_version`, so this is your promise, not a lock (the pack carries it in its signed listing, and `verify` reads it from there: it warns when a pack that uses `hero` declares nothing or less than 0.1.182).
- Example: `kit/examples/hero-gallery` (offline; the script draws the pictures). Not seen in a running Bolt 182 yet: written from the 182 source and sample runs.

## Press a row or tile (Bolt 0.1.184)

A `table` or `cards` pane can make each item a control. `bind.activate` says what Enter, Space or a click on one item does: exactly one of `nav` or `action`.

```yaml
right_widget:
  kind: table
  mode: list_data
  bind:
    columns: [{ field: service, label: Service }, { field: commits, label: Commits }]
    activate:
      nav: { view: detail, arg: "{{row.service}}" }
```

- `nav` opens a view of the same app, the way a `nav` row does (one step deeper, Back and Esc return to the same row). `view` is a key of `presentation.views` and the app needs `view_arg`. `arg` is a `{{row.field}}` template that must give ONE plain token (letters, digits, `_ . -`, at most 64, not starting with `-` or `.`, no `..`). An item whose value is not a token, or has no such field, is not pressable and behaves as before (a table row copies itself, a tile copies its title). Structured context is not passed.
- `action` is the `id` of a declared `url` or `composer` action; it runs with the item's own row. A `run` or `utility` action cannot take an item's fields, so it is refused by lint and does nothing in Bolt.
- A view or action the app does not declare is a lint error, and a no-op in Bolt.
- Tab reaches a pressable table row; a tile is a button. A held Enter does not press twice, and nothing runs while a dialog is open.
- Set `"min_bolt_version": "0.1.184"` in `bolt-app.json`: a Bolt 0.1.183 or older refuses the whole pack that uses the key (a personal `schema_version: 1` file only warns and the item copies as before).
- Example: `kit/examples/widget-gallery` (the table view drills into the detail view). Not seen in a running Bolt 184 yet: written from the 184 source and sample runs.

## Typing free text and views in a script app

The view is read from query word 0 (`view_arg` bound to `query.word(0)`), so a script app that also takes free text treats the first word as a view only when it is one of its view names and otherwise reads every word as text (`=insights ~/data.csv`, `=insights trend`). A text that starts with a view name needs a leading `./` or a different spelling. Words before the view word would need plain-word defaults (lint `view_arg_lead_default`); a default of `-` is fine for words after it. A nav row carries no actions and cannot carry text with a slash; keep the last typed text in the kit cache. To give a drilled-in view a button, add an ordinary row with `kit.action_chain(id, label, target_chip, query)` pointing at the app's own chip: a utility action to itself. That is not yet proven in the launcher.

## Three starting states (`api.key_env` and `api.on_missing_key`)

1. **Live with a key.** The key is found (environment, keychain or `~/.config/<id>/.env`): the app calls its API and shows real data.
2. **Sample fallback** (`"on_missing_key": "sample"`, for demos and templates whose API is a placeholder: every `new` copy of such a template first runs as labelled sample data, never as a "could not reach" error; `new` prints the step "connect your API"): no key, so the app shows its labelled sample data and never replaces it. Where the view is a tiles grid (a row with no number draws an empty "-" tile) the label rides on real tiles: the badge says SAMPLE, a footer says "sample data: add your ... API key for live data" (or the first tile's note, when every footer is in use; real data is never overwritten). Every other view keeps two visible rows: "SAMPLE DATA: add your ... API key to see live data" and a key-hint row. Chart and table data views carry neither, because the row would become a data point. A tiles overview also has no Refresh row for the same reason.
3. **Setup only** (`"on_missing_key": "setup"`, the default, for a real app): no key, so the app shows one row that says how to add it. That row carries no tile and no pane.

`BOLT_APP_FIXTURE=1` always shows sample data, and says so only for an app with `api.fixture_banner` set (the other demos show the data without a label in that mode, which is a test and terminal mode), `0` always goes live. The SAMPLE DATA and key-hint rows of state 2 are left out of chart and table views, where a label row would become a data point. A key file with open permissions keeps its own "tighten the permissions" row and is never replaced by sample data. `on_missing_key` must be `setup` or `sample`. `bolt-apps ship` and `bolt-apps doctor <folder>` say which state the app starts in.

## Shared kit (Bolt 182)

Status: partial. It needs Bolt 182 or newer, and it has NOT been run in a real installed Bolt yet: it is proven by tests that run real Python against a stand-in folder, and by the Bolt side's unit tests. On Bolt 0.1.181 nothing changes: the variable below is never set, so every app runs on its own vendored kit.

- `BOLT_APP_SHARED_DIR` is an environment variable that Bolt 182 sets for a script app. It names a read-only folder inside the Bolt app with `manifest.json`, `bolt_app_kit.py` and `LICENSE`. Bolt sets it only after checking every file in that folder against a hash table compiled into Bolt; if anything differs, a file is missing, or the person turned the shared kit off in settings, Bolt leaves the variable out. A manifest in your app cannot set or forward it (names starting `BOLT_` are refused).
- `./bolt-apps kit export-shared <empty-folder>` writes that same folder from this repo's kit. It is the only thing that produces Bolt's copy. It refuses a folder that holds anything else, and a link.
- `./bolt-apps check <app> --shared` runs every case with the variable pointing at a fresh export, and fails with `shared_kit_not_used` unless the script's kit really came from that folder. An app that keeps its own different copy, or does not use the loader, is reported as not using the shared kit.
- The loader (one source: `toolkit/lib/loader.mjs`, copied into each script that adopts it) uses the shared kit only when ALL of these hold: the path is absolute (on Windows: a drive letter, no network share); the manifest is format 1 with the same `KIT_API` the script knows; the kit file hashes to the manifest; the file names the manifest's version; and either the app's own vendored kit has the very same bytes, or the app sets `WANT_SHARED = True` and the shared version is at least `KIT_MIN`. Otherwise it quietly runs the app's own copy. A Ctrl-C is never swallowed.
- `WANT_SHARED = True` means: run whatever kit Bolt hands over, even though it differs from the copy you tested with. You are trusting whoever controls that environment variable. In Bolt that is Bolt itself, and the hash table is compiled into Bolt, so a changed file is refused; but you will get kit fixes and kit changes without re-shipping your app, so keep `KIT_MIN` honest. Leave it `False` and the app only ever uses a byte-identical copy.
- Existing apps keep their own copy. Nothing is converted for you: an app starts using this only when its author re-ships it with the new loader (`unit-convert` is the one example that has it so far).
- Not covered yet: the engine is not shared (each example still carries its own), thin apps without a vendored kit, upgrading many apps at once, and any run on Windows or Linux Bolt.
