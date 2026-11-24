# What a Bolt App can do

_Generated from `capabilities.json` by `scripts/build-capabilities.mjs`: edit the JSON, not this file._

One row per capability. Status is derived from the code and `schema/bolt-rules.json`. Nothing here is verified in real Bolt yet. The sandbox is not shipped: a personal script runs as you. To start, read [QUICKSTART.md](QUICKSTART.md); the limits are in its one rules table.

| Capability | Status | Example | Proven by | Limit |
|---|---|---|---|---|
| Pane: card | supported | [widget-gallery-2](widget-gallery-2) | `kit/examples/widget-gallery-2/check.json` | One card for the selected row. Strings in bind: up to 4096 characters. |
| Pane: markdown | supported | [widget-gallery](widget-gallery) | `kit/examples/widget-gallery/check.json` | The bind.body template is limited to 16384 characters (the expanded body is not); the kit hands at most 8000 characters and 40 lines. |
| Pane: entity_preview | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | Facts list up to 40 entries, one tile above. Config default for a detail view. |
| Pane: chart | supported | [widget-gallery](widget-gallery) | `kit/examples/widget-gallery/check.json` | Types line, bar and sparkline on every Bolt; pie, donut, area and bind.series need Bolt 0.1.182 (see the next rows). Title is the label bind as literal text. |
| Pane: table | supported | [widget-gallery](widget-gallery) | `kit/examples/widget-gallery/check.json` | Up to 40 columns; totals sum, avg, min, max, count; the engine hands it at most 50 rows. |
| Pane: cards | supported | [acme-dash](acme-dash) | `kit/examples/acme-dash/check.json` | Layout tiles (a tile per row, at most 24 rows, and a row with no number draws an empty "-" tile) or the default grid (up to 500 cards, no number needed); tile label cut at 24 characters. The 24 cap applies only to bind.layout tiles. |
| Pane: detail | supported | [widget-gallery](widget-gallery) | `kit/examples/widget-gallery/check.json` | Label and value fields of the selected row. |
| Pane: json_tree | supported | [widget-gallery](widget-gallery) | `kit/examples/widget-gallery/check.json` | Reads a nested object from the row field named in bind.source. |
| Pane: diff | supported | [widget-gallery](widget-gallery) | `kit/examples/widget-gallery/check.json` | Two texts, line by line. It draws only the text its bind gives it: left and right templates of the selected row, and in 181 it can show an empty Compare box when a row carries none. For what changed, prefer a detail pane (Before, After, Change). Verified in a launcher: not yet. |
| Pane: image_grid | supported | [widget-gallery-2](widget-gallery-2) | `kit/examples/widget-gallery-2/check.json` | 1 to 8 columns. Inline data:image only (png, jpeg, gif, webp, avif, bmp), 1 MiB each and 4 MiB per render; remote images never load in a personal app. A tile is a square, cropped. Clicking a tile asks the launcher to open the tile's src as a link; an inline image is not one, so read it as a refusal and caption every tile instead (from the launcher source, not seen running). |
| Pane: entity_preview picture (image_url) | partial | [script-template](script-template) | `kit/python/tests/test_script_template_live.py` | The selected row's picture draws above the title, but as a 40 pixel square avatar by design of the entity preview (181 gives a User App no large variant): for a large picture use a markdown pane (row markdown.inline_picture), or from Bolt 182 the entity_preview hero (row widget.entity_preview_hero). image_url must expand to an inline data:image (up to 1 MiB); a web address draws nothing. A row text field is cut at 4,000 characters, so a picture of more than about 3 KB is split over fields and joined in the template. Read from the launcher source and sample runs, not seen in a running Bolt. |
| Pane: entity_preview hero picture (Bolt 182) | partial | [hero-gallery](hero-gallery) | `kit/python/tests/test_hero.py` | Needs Bolt 182. A full-width picture above the tile and title, aspect kept, at most 360 px high, with a rounded frame, an optional caption and credit line (caption, alt and credit at most 200 characters each). src must expand to an inline data:image (png, jpeg, gif, webp, avif or bmp, up to 1 MiB); a web address is blocked, and a missing or invalid src draws no hero and leaves the pane as it was. src is a template that may join at most 16 {{ }} references (4096 characters), and a row text field is cut at 4,000 characters, so a picture can take at most 16 fields: about 47 KB. The stdlib cannot resize, so give kit.hero_fields() an already small png, jpeg, gif or webp (it refuses avif and bmp bytes, which Bolt takes: pass a data:image/avif;base64 string and it is split as it is) (it refuses one that needs more than 16 parts: use a smaller picture). A Bolt 0.1.181 REFUSES THE WHOLE PACK when one app uses hero ("unknown key for a entity_preview pane"), and a local schema_version 1 file only warns and shows no hero: so bolt-app.json must say min_bolt_version 0.1.182 (a proposal: Bolt does not read it, bolt-apps lint, check and pack require it, and the pack carries it in its listing) and the pack must go only to people on Bolt 182 or newer. image_url stays the 40 pixel avatar. From the Bolt 182 source and sample runs, not seen in a running Bolt 182. |
| Pane: markdown with a big inline picture | partial | [script-template](script-template) | `kit/python/tests/test_script_template_live.py` | A markdown body keeps an inline data:image (png, jpeg, gif, webp, avif, bmp; up to 1 MiB, 4 MiB a render) and draws it at its own size, shrunk to the pane width with its proportions kept (Tailwind base rule max-width 100%, height auto; no crop, no fixed height); a tall picture scrolls in the pane. The bind.body template is limited to 16384 characters (the expanded body is not), so about 24 fields of 4,000 characters (a 400 pixel wide JPEG of 70 KB); keep it to one row (the detail), not every list row. Text from an API must be escaped for markdown (script-template md_escape) or its brackets, links and html act as markdown. Read from the pane source, a vitest on the real MarkdownWidget and a browser measurement of the same CSS, not seen in a running Bolt. |
| A picture from a web API in a pane | partial | [script-template](script-template) | `kit/python/tests/test_script_template_live.py` | The app cannot point a pane at a web picture (every pane loads inline data: images only). Its script fetches a small JPEG from an allowlisted host (name the picture host in hosts, not only the API host), checks it, and puts it in the row as data:image/jpeg;base64 split over img1 to img4 (about 12 KB of picture in all). Ask the host for a small size; one that is too big is dropped, the row stays. Read from the launcher source and sample runs, not seen in a running Bolt. |
| Panes: image, color, weather, date, calc | not supported | none | `toolkit/test/launcher-rules.test.mjs` | A personal app cannot show its own data in these panes: Bolt shows "This app asks for ... pane, which cannot show app data". |
| Pane: map | not supported | none | `toolkit/test/launcher-rules.test.mjs` | Draws the launcher own map, not your rows; any bind key is refused. No message is shown. |
| Chart types: pie, donut, area, several lines (bind.series) | supported | [chart-types](chart-types) | `toolkit/test/charts-182.test.mjs` | Needs Bolt 0.1.182: set min_bolt_version 0.1.182 in bolt-app.json, because a 181 refuses the whole pack. Pie and donut take positive values and at most 12 slices; bind.series is up to 4 lines on line or area, with no color. |
| Pane: heatmap | supported | [chart-types](chart-types) | `kit/examples/chart-types/check.json` | Needs Bolt 0.1.182 (min_bolt_version 0.1.182). Grid, matrix or calendar data, 24 columns and 24 rows at most. Drawn by no real Bolt in this repo yet: the app is lint and fixture tested only. |
| Pane: gauge | supported | [chart-types](chart-types) | `kit/examples/chart-types/check.json` | Needs Bolt 0.1.182 (min_bolt_version 0.1.182). bind.value is required; the selected row is shown. Drawn by no real Bolt in this repo yet: the app is lint and fixture tested only. |
| presentation.widget (list, table, cards, detail) | partial | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | Only validated: it names the row layout and does not change the left list. With table, cards or detail and no right_widget the right panel opens empty (from the source, not run live). Use list. |
| Several views in one app | supported | [acme-dash](acme-dash) | `kit/examples/acme-dash/check.json` | At most 8 entries in presentation.views; the overview needs no entry (the engine uses 7 plus an overview entry); view ids match `^[a-z][a-z0-9_-]{0,23}$`. |
| Drill from an overview row to a list | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | One Enter. A nav arg is one plain token matching `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`; no slash. A chain to another app, or a chain a script writes on a row, only pre-fills the next command (second Enter); a fixed-text chain to the same app written in the app file runs directly. Use nav to drill. |
| Back row on a drilled-in view | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | A nav row carries no actions. The first row of a drilled list is selected when it opens: give your Back row a pane text (title, subtitle, body), or a detail, card, diff or json_tree pane draws only dash placeholders. The engine does it for you (it declares a `note` view); a script app passes `kit.back_row(subtitle, view=kit.NOTE_VIEW)` and declares a `note` markdown view. check fails a selectable row that binds nothing (`pane_blank_row`). |
| Drill from a row to related rows of another view | supported | [acme-dash](acme-dash) | `kit/examples/acme-dash/check.json` | The related view lists rows whose match field equals this row id. No cross-join of two endpoints. |
| Row id from another field (id_field, parent_field) | supported | [feed-template](feed-template) | `kit/examples/feed-template/check.json` | id_field names the row field used as the id (default id); parent_field is on a children entry. A nav arg is one token, so an id with a space does not work. |
| Filter a list by a typed word | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | The word filters title, subtitle, badge and the first 5 fields. It is the second word typed; there is no filter field in a row. |
| Rows are filtered as you type | supported | [table-template](table-template) | `kit/examples/table-template/check.json` | Bolt always filters the rows of the last run as you type: every term must be in the title or subtitle, and a Run row is added. presentation.searchable is accepted and does nothing. |
| Fresh cache and a stale copy when the API fails | supported | [portal-template](portal-template) | `kit/python/tests/test_cache_rows.py` | ttl seconds a result is fresh; stale_max seconds an old copy may be shown with its age. A failed call is never cached or shown as zero. |
| A detail pane that changes with the selected row | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | Works when the row `pane` names a declared view whose right_widget has mode selected_row and kind entity_preview, detail, markdown, json_tree, chart, table or card. Ignored for mode list_data, a view with no right_widget, or kind diff, cards or image_grid. |
| Number tiles with a meter, unit, note and badge rules | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | Unit at most 4 characters; trend keeps 30 points. |
| Tile ring, bullet and sparkline limit | supported | [widget-gallery-2](widget-gallery-2) | `toolkit/test/tiles-184.test.mjs` | Bolt 0.1.184 or newer: set min_bolt_version 0.1.184 in bolt-app.json (an older Bolt refuses the whole pack, or warns and ignores the key in a personal schema_version 1 file; Bolt does not read min_bolt_version, so this is the author's promise and a lint error). visual is meter (default), ring or bullet and needs a max; target and limit are numbers or {{row.x}} references; anything else draws the plain meter. Tiles in entity_preview tiles_above do not read them. |
| Footer buttons (url, composer, utility) | supported | [acme-dash](acme-dash) | `kit/examples/acme-dash/check.json` | Bolt shows at most 6 footer buttons; the kit and engine keep to 3 (Open and Copy count). Bolt keeps 40 label characters; the button shows 14. |
| Run action: one click runs this app with a fixed query | supported | no example yet; copy the snippet | `toolkit/test/launcher-rules.test.mjs` | kind run needs a query_template of fixed text. No example yet. |
| Footer button icon | supported | no example yet; copy the snippet | `toolkit/test/bolt-rules.test.mjs` | Icon names are lowercase and case-sensitive, from the list in schema/bolt-rules.json (actions.icons); anything else is refused at load. A url action never takes an icon: it always wears the open glyph. |
| Open a place in Maps from a row (instead of a map pane) | supported | [places-list](places-list) | `kit/examples/places-list/check.json` | A personal app cannot draw the map pane; the row Open button opens the place in a browser. |
| Row actions: Open and Copy from config | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | Config rows carry Open (url) and Copy (copy) only; more buttons need the app file actions. |
| Icons in config.json and the app file | supported | [portal-template](portal-template) | `kit/python/tests/test_review_engine.py` | Icon names are case-sensitive: config.json names come from kit/schema/icons.json; footer-action icons come from actions.icons. |
| Typed input form with validation | supported | [form-template](form-template) | `kit/examples/form-template/check.json` | Types text, number, date, select, toggle. Bad input shows one "Not saved" row and saves nothing. |
| Secret input field | partial | no example: not recommended | `toolkit/test/bolt-rules.test.mjs` | The launcher accepts type secret but the value reaches the script as a plain word and the run log is not measured. Use the keychain or a 0600 .env file. |
| REST list endpoint | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | GET only; at most 50 rows per list; 10 s per request, 14 s together. |
| A list of ids, then one request per id | supported | [feed-template](feed-template) | `kit/python/tests/test_round2_engine.py` | limit 1 to 50; requests run in parallel; ids that fail are dropped. |
| API key sent as a query parameter | supported | [feed-template](feed-template) | `kit/python/tests/test_round2_engine.py` | The key is stripped from the answer before anything is cached or shown. Prefer a header when the API allows it. |
| API key sent in a header | supported | [portal-template](portal-template) | `kit/examples/portal-template/check.json` | The key goes only to the host of base_url. |
| No key at all | supported | [lookup-template](lookup-template) | `kit/examples/lookup-template/check.json` | Leave key_env out. |
| Date tokens in a path: {today}, {today-7d}, {today+1d} | supported | [feed-template](feed-template) | `kit/python/tests/test_round2_engine.py` | Local dates, 0 to 9999 days; sample mode uses _now from fixtures.json. |
| An object of lists keyed by date or name | supported | [feed-template](feed-template) | `kit/python/tests/test_round2_engine.py` | flatten is true or the field name that keeps the key; keys sort. |
| A second host for one endpoint | supported | [lookup-template](lookup-template) | `kit/examples/lookup-template/check.json` | Full addresses must be https on the base_url host or a host in allowed_hosts. The key is never sent to a second host. |
| Refuse an answer that lacks fields | supported | [lookup-template](lookup-template) | `kit/examples/lookup-template/check.json` | On an object endpoint; an answer without them counts as failed, never as zero. |
| Chain endpoints: one answer feeds the next path | supported | [lookup-template](lookup-template) | `kit/examples/lookup-template/check.json` | Lookup mode only: {earlier_step.field} and {query}; values are URL-quoted. Views mode cannot call a per-id endpoint. |
| A command line tool | supported | [cli-wrapper-template](cli-wrapper-template) | `kit/examples/cli-wrapper-template/check.json` | Personal pack only; argument list, no shell; per-OS command table; 60 s at most; stderr is not seen. |
| A service on this computer (http_local) | supported | [local-service-template](local-service-template) | `toolkit/test/personal.test.mjs` | Loopback only, one GET or POST, no script, no secrets. Bolt reserves ports 13017 to 13027 and 15432 to 15441. |
| A local file the person names | supported | [file-insights-template](file-insights-template) | `kit/examples/file-insights-template/check.json` | Declare files; caps on size; a path cannot travel in a nav arg. |
| An MCP server | partial | snippet in ENGINE.md | `toolkit/test/cold-agent.test.mjs` | No native MCP runtime. A bridge script can call one tool over stdio; tested only against a stand-in server, not a real MCP server. |
| Keys from the keychain or a private file | supported | [portal-template](portal-template) | `kit/python/tests/test_secrets.py` | Lookup order: environment (terminal only), keychain, then a 0600 .env file. A shell variable does not reach the script under Bolt. |
| Keys stripped from API answers before cache | partial | [feed-template](feed-template) | `kit/python/tests/test_round2_security.py` | Strips the key (as written, URL-encoded, hex, base64, any letter case), user:password@ and credential-named query values, also inside nested, fragment and encoded links. Cannot strip: HTTP Basic base64 at another alignment, HTML entities, colon-separated hex, a split key, a key held as a JSON number, a value encoded twice. A key under 3 characters is refused. |
| Failure: exit code and stderr | supported | see the kit error_row | `conformance/launcher-constants.json` | A non-zero exit discards every printed row; the person sees `<chip> unavailable: exit code N:` and up to 2 KiB of stderr. From the source, not run live. |
| What nav needs to work | supported | [portal-template](portal-template) | `conformance/launcher-constants.json` | view_arg bound to query.word(N) with N at most 8; every query.word arg before it needs a one-token default (not -). Otherwise no row can drill, silently. |
| Back, Esc, Left and Right | supported | [portal-template](portal-template) | `conformance/launcher-constants.json` | Esc and Left go Back, Right drills with the caret at the end, up to 16 deep. |
| Recently shown lists are reused | partial | automatic | `conformance/launcher-constants.json` | The launcher keeps the last 8 lists for 5 minutes by typed input, so a drill, Back or Refresh to a recent input may not run the script again. From the source, not verified live. |
| Command variables: limit, press, outname | supported | see the engine app files | `conformance/launcher-constants.json` | {{limit}} is always 24 and does not cap rows; {{press}} is the clicked run action id, else -; {{outname}} is for bundled apps only. A value that would begin an argument with - is refused except after --. |
| Rows that open as files | supported | no example yet | `conformance/launcher-constants.json` | Needs emits: File and a row path starting /, ~/ or a drive letter; a trailing slash is a folder; a UNC path is refused. From the source, not run live. |
| One action takes Enter (primary) | supported | no example yet | `conformance/launcher-constants.json` | At most one primary in the app file; it takes Enter on every row and the others go in the Tab menu. |
| Chart rows mixed with plain rows | supported | [widget-gallery](widget-gallery) | `conformance/launcher-constants.json` | A row without the y field is skipped, so one list can hold chart rows and plain rows. The unit is cut at 8 characters. |
| What Bolt does limit about a run | partial | automatic | `conformance/launcher-constants.json` | Each run gets a fresh private working folder (not the app folder) unless bridge.cwd is home, its process tree is killed on timeout, and there are CPU and process limits. Files and network are not confined. Bolt sets 6 variables: the 3 Python ones and GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT, GIT_OPTIONAL_LOCKS. |
| Sample data: no key, no network | supported | [portal-template](portal-template) | `kit/python/tests/test_portal_engine.py` | Ship live (api.fixture_default false) unless the app is sample-only by design (see sample.offline_only). Put "fixture": true at the top of check.json; an installed pack cannot be switched to sample data. |
| Several sources at once inside one deadline | supported | [system-glance](system-glance) | `kit/python/tests/test_probe.py` | Partial failure shows per-source rows; an unread value is never zero. |
| permissions block in the app file | partial | no example yet | `toolkit/test/cold-agent.test.mjs` | Declared and shown at install and compared with what the files use (permissions_differ). Bolt does not enforce it at run time (link host limits will start applying when the device wiring ships). |
| Sandbox: a script confined to what it declares | not supported | none | `toolkit/test/docs-drift.test.mjs` | Not shipped. A personal script runs as you, with your files and network. Confinement is planned. Install only code you have read. |
| Windows | partial | see any example app file | `toolkit/test/kit.test.mjs` | Unproven: the command table accepts a windows entry and check can run fixtures labelled windows, but nothing has been run on Windows. |
| Chip must equal id | supported | [portal-template](portal-template) | `toolkit/test/namespacing.test.mjs` | The app file's chip must be its id (`chip_not_id` is an error in lint --personal, verify and pack). Bolt 181 and main look apps up by id, so a different chip is offered in the launcher but never runs: an empty list and no error. |
| Three start states: live with a key, labelled sample data, setup row only | supported | [portal-template](portal-template) | `toolkit/test/namespacing.test.mjs` | api.on_missing_key is setup (default: no key shows one setup row, no sample data) or sample (no key shows the labelled sample data, with the label and key hint on a tile in tile views). A key file with open permissions keeps its own row. BOLT_APP_FIXTURE=1 always shows sample data. Sample label by pane kind: a tiles grid carries it on the first tile (badge, footer or note); an entity_preview or markdown list gets a visible SAMPLE DATA row and a key-hint row; chart, table, diff, json_tree, image_grid, detail and card views carry it in the first row's subtitle (a label row there would be a data point or a blank pane). |
| Approval after every reship | supported | [portal-template](portal-template) | `toolkit/test/namespacing.test.mjs` | A personal app is approved per set of files. Every reship changes the files, so approve again; the first run asks too. On 181 pressing Enter on an unapproved app shows an empty list (fixed on a later build). |
| Share common code between apps | not supported | none | `toolkit/test/namespacing.test.mjs` | On 181 every app ships its own files under scripts/ID__name, kit included, so a kit fix needs a re-vendor and a reship of each app (a later upgrade-kit command is planned). A shared library installed once is a Bolt 182 feature, not available now. |
| A first word that is not a view (a place, a repo, a host) | supported | [around](around) | `toolkit/test/namespacing.test.mjs` | The launcher draws such a run with the APP-LEVEL right_widget, not a view's, so that widget must tolerate rows with no value: use a selected_row entity_preview (tile on top), never a tiles grid over mixed rows. check runs your sample cases with a free-text first word and refuses a tiles grid there (tile_row_without_value). |
| One app that takes a typed query AND drills (lookup plus views) | partial | [portal-template](portal-template) | `toolkit/test/cold-run.test.mjs` | Not in one app when the API must be asked per typed word: lookup mode has {query} but no drill or Back, views mode has drill and Back but its first word is a view, never a query (an unknown first word shows the overview). What works in views mode: a view name then one word filters that list inside the app, and Enter drills through children. Otherwise build two apps (two chips). ENGINE.md, Two shapes of app. |
| Buttons on a lookup row | partial | [lookup-template](lookup-template) | `toolkit/test/cold-run.test.mjs` | Open (url) and Copy only: no drill, no Back, no extra actions. In a chained lookup (steps and rows) a row's copy is ignored and Copy copies the row text; check warns (config_copy_ignored). With a single endpoint and an item, item.copy works. |
| An app that only shows sample data (offline, no API) | supported | no shipped example sets api.fixture_default true; the recipe is in ENGINE.md | `toolkit/test/cold-run.test.mjs` | Sample-only by design: fixture_default true, a base_url that cannot resolve, no key_env. ship and doctor print the same start mode. The data is signed with the pack. |
| A text-only lookup result (no empty tile) | supported | [lookup-template](lookup-template) | `kit/python/tests/test_cold_run2_engine.py` | tiles_above draws only for a row with a number, so rows with text only draw no tile. Give every text-only row a body. A tiles grid (cards, bind.layout tiles) over rows with no number is an error in check. From source and sample runs, not seen in a running Bolt. |
| Shared kit from Bolt (Bolt 182) | partial | [unit-convert](unit-convert) | `toolkit/test/shared-kit.test.mjs` | Needs Bolt 182; on 181 the app runs its own vendored kit. Bolt offers BOLT_APP_SHARED_DIR only after a hash check against a table compiled into Bolt, and the loader checks the folder again; any doubt means the app's own copy. WANT_SHARED = True trusts whoever controls that variable (Bolt does). Not seen in a running Bolt; the engine is not shared; existing apps keep their own copy until their author reships with the new loader; only unit-convert has the loader so far. |

## Snippets

### Pane: card (`widget.card`)

```
{"kind": "card", "mode": "selected_row", "bind": {"title": "{{row.name}}", "subtitle": "{{row.note}}", "actions": ["copy"]}}
```

### Pane: markdown (`widget.markdown`)

```
{"kind": "markdown", "mode": "selected_row", "bind": {"title": "{{row.title}}", "subtitle": "{{row.subtitle}}", "body": "{{row.body}}", "actions": ["copy"]}}
```

### Pane: entity_preview (`widget.entity_preview`)

```
{"kind": "entity_preview", "mode": "selected_row", "bind": {"title": "{{row.title}}"}}
```

### Pane: chart (`widget.chart`)

```
{"kind": "chart", "mode": "list_data", "bind": {"type": "bar", "x": "label", "y": "value", "label": "label"}}
```

### Pane: table (`widget.table`)

```
{"kind": "table", "mode": "list_data", "bind": {"sort": {"field": "commits", "dir": "desc"}, "totals_label": "Total"}}
```

### Pane: cards (`widget.cards`)

```
{"kind": "cards", "mode": "list_data", "bind": {"layout": "tiles"}}
```

### Pane: detail (`widget.detail`)

```
{"kind": "detail", "mode": "selected_row", "bind": {"title": "{{row.service}}"}}
```

### Pane: json_tree (`widget.json_tree`)

```
{"kind": "json_tree", "mode": "selected_row", "bind": {"source": "data"}}
```

### Pane: diff (`widget.diff`)

```
{"kind": "diff", "mode": "selected_row", "bind": {"left": "{{row.left}}", "right": "{{row.right}}"}}
```

### Pane: image_grid (`widget.image_grid`)

```
{"kind": "image_grid", "mode": "list_data", "bind": {"src": "{{row.src}}", "caption": "{{row.name}}", "columns": 3}}
```

### Pane: entity_preview picture (image_url) (`widget.entity_preview_image`)

```
{"kind": "entity_preview", "mode": "selected_row", "bind": {"title": "{{row.title}}", "image_url": "{{row.img1}}{{row.img2}}"}}
```

### Pane: entity_preview hero picture (Bolt 182) (`widget.entity_preview_hero`)

```
{"kind": "entity_preview", "mode": "selected_row", "bind": {"hero": {"src": "{{row.img1}}{{row.img2}}", "alt": "{{row.hero_alt}}", "caption": "{{row.hero_caption}}", "credit": "{{row.hero_credit}}"}, "title": "{{row.title}}", "body": "{{row.body}}"}}
```

### Pane: markdown with a big inline picture (`markdown.inline_picture`)

```
{"kind": "markdown", "mode": "selected_row", "bind": {"body": "![{{row.hero_alt}}]({{row.img1}}{{row.img2}}{{row.img3}}{{row.img4}}){{row.hero_lines}}", "actions": ["open", "copy"]}}
```

### A picture from a web API in a pane (`data.web_picture`)

```
{"kind": "cards", "mode": "list_data", "bind": {"layout": "grid", "title": "{{row.title}}", "image": "{{row.img1}}{{row.img2}}{{row.img3}}{{row.img4}}"}}
```

### Chart types: pie, donut, area, several lines (bind.series) (`widget.chart_182`)

```
{"kind": "chart", "mode": "list_data", "bind": {"type": "pie", "x": "label", "y": "value", "label": "Deploys by day"}}
```

### Pane: heatmap (`widget.heatmap`)

```
{"kind": "heatmap", "mode": "list_data", "bind": {"x": "hour", "y": "day", "value": "requests"}}
```

### Pane: gauge (`widget.gauge`)

```
{"kind": "gauge", "mode": "selected_row", "bind": {"value": "{{row.score}}", "max": "100", "shape": "half"}}
```

### presentation.widget (list, table, cards, detail) (`layout.list_widget`)

```
presentation:
  widget: list
```

### Several views in one app (`layout.views`)

```
"views": [{"id": "tasks", "endpoint": "tasks"}]
```

### Drill from an overview row to a list (`nav.drill`)

```
{"title": "Open tickets", "view": "tickets", "arg": "open"}
```

### Back row on a drilled-in view (`nav.back`)

```
(automatic: the engine adds a Back row to every drilled-in view)
```

### Drill from a row to related rows of another view (`nav.children`)

```
"children": [{"view": "tasks", "match": "control_id"}]
```

### Row id from another field (id_field, parent_field) (`nav.id_field`)

```
{"id": "asteroids", "endpoint": "asteroids", "id_field": "neo_reference_id", "children": [{"view": "sameday", "match": "date", "parent_field": "date"}]}
```

### Filter a list by a typed word (`search.filter_word`)

```
=portal tickets urgent
```

### Rows are filtered as you type (`search.searchable`)

```
(nothing to set: Bolt always does this)
```

### Fresh cache and a stale copy when the API fails (`cache.fresh_stale`)

```
"cache": {"ttl": 45, "stale_max": 86400}
```

### A detail pane that changes with the selected row (`pane.per_row`)

```
{"kind": "entity_preview", "mode": "selected_row"}
```

### Number tiles with a meter, unit, note and badge rules (`pane.tiles`)

```
"tile": {"label": "Open tickets", "value": "tickets_open", "max": "tickets_total", "badge": [{"if": "tickets_open>0", "badge": "ACTION"}, {"badge": "CLEAR"}]}
```

### Tile ring, bullet and sparkline limit (`pane.tile_visuals`)

```
"bind": {"layout": "tiles", "value": "{{row.value}}", "max": "{{row.max}}", "visual": "bullet", "target": "{{row.target}}", "trend": "{{row.trend}}", "limit": "{{row.limit}}"}
```

### Footer buttons (url, composer, utility) (`actions.footer`)

```
actions:
  - { id: copy, kind: composer, target: row, label: Copy, insert: "{{row.copy_text}}" }
```

### Run action: one click runs this app with a fixed query (`actions.run`)

```
actions:
  - { id: refresh, kind: run, label: Refresh, query_template: "overview refresh" }
```

### Footer button icon (`actions.icon`)

```
actions:
  - { id: log, kind: composer, target: row, label: Copy log, icon: file-text, insert: "{{row.copy_text}}" }
```

### Open a place in Maps from a row (instead of a map pane) (`actions.maps_link`)

```
"url": "https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"
```

### Row actions: Open and Copy from config (`actions.row`)

```
"url": "https://app.example.com/tickets/{id}"
```

### Icons in config.json and the app file (`icons.names`)

```
"icon": "globe"
```

### Typed input form with validation (`inputs.form`)

```
"form": {"inputs": [{"name": "amount", "type": "number", "label": "Amount", "required": true}]}
```

### Secret input field (`inputs.secret`)

```
(not used by any example; read the key with get_secret instead)
```

### REST list endpoint (`api.rest_list`)

```
"endpoints": {"tickets": {"path": "/v1/tickets", "map": {"title": "summary"}}}
```

### A list of ids, then one request per id (`api.id_hydrate`)

```
"news": {"path": "https://hacker-news.firebaseio.com/v0/topstories.json", "hydrate": {"path": "https://hacker-news.firebaseio.com/v0/item/{id}.json", "limit": 8}}
```

### API key sent as a query parameter (`api.query_key_auth`)

```
"api": {"auth_in": "query", "auth_param": "api_key"}
```

### API key sent in a header (`api.header_auth`)

```
"api": {"key_env": "EXAMPLE_API_KEY", "auth_header": "Authorization", "auth_prefix": "Bearer "}
```

### No key at all (`api.keyless`)

```
"api": {"base_url": "https://api.open-meteo.com", "fixture_default": false}
```

### Date tokens in a path: {today}, {today-7d}, {today+1d} (`api.date_tokens`)

```
"asteroids": {"path": "/neo/rest/v1/feed?start_date={today-2d}&end_date={today}"}
```

### An object of lists keyed by date or name (`api.object_keyed_lists`)

```
"asteroids": {"data": "near_earth_objects", "flatten": "date"}
```

### A second host for one endpoint (`api.second_host`)

```
"api": {"allowed_hosts": ["geocoding-api.open-meteo.com"]}
```

### Refuse an answer that lacks fields (`api.require`)

```
"require": ["current"]
```

### Chain endpoints: one answer feeds the next path (`api.chain`)

```
"lookup": {"steps": ["geocode", "weather"]}
```

### A command line tool (`api.cli`)

```
"commands": (see config.json)
```

### A service on this computer (http_local) (`api.local_http`)

```
http:
  port: 11434
  request: { method: GET, path: /api/tags }
  parse: json
```

### A local file the person names (`api.file`)

```
(path comes from the query word; see insights.py)
```

### An MCP server (`api.mcp`)

```
(see the MCP workaround script in ENGINE.md)
```

### Keys from the keychain or a private file (`secrets.private_key`)

```
"api": {"key_env": "EXAMPLE_API_KEY", "env_file": "~/.config/portal-template/.env"}
```

### Keys stripped from API answers before cache (`secrets.redaction`)

```
kit.redact_tree(answer, [key], auth_param)
```

### Failure: exit code and stderr (`rows.failure_channel`)

```
(print an error row and exit 0; write diagnostics to stderr)
```

### What nav needs to work (`nav.binding`)

```
view_arg: view   # bound to query.word(0)
```

### Back, Esc, Left and Right (`nav.keyboard`)

```
(automatic)
```

### Recently shown lists are reused (`drill.cache`)

```
(automatic; give a Refresh row a distinct arg)
```

### Command variables: limit, press, outname (`runtime.vars`)

```
"{{scripts_dir}}/my-app__app.py {{view}} {{arg}}"
```

### Rows that open as files (`rows.emits_file`)

```
emits: File (row path: ~/notes.txt)
```

### One action takes Enter (primary) (`actions.primary`)

```
actions:
  - { id: open, kind: url, label: Open, primary: true, url_template: "{{row.open_url}}" }
```

### Chart rows mixed with plain rows (`pane.chart_mixed`)

```
{"kind": "chart", "mode": "list_data", "bind": {"type": "bar", "x": "label", "y": "value", "label": "label"}}
```

### What Bolt does limit about a run (`run.isolation`)

```
(automatic)
```

### Sample data: no key, no network (`sample.mode`)

```
"api": {"fixture_default": false, "fixture_file": "fixtures.json"}
```

### Several sources at once inside one deadline (`parallel.sources`)

```
(kit.run_parallel in the script)
```

### permissions block in the app file (`permissions.block`)

```
permissions:
  network:
    - { host: api.example.com }
```

### Windows (`platform.windows`)

```
"windows": "python {{scripts_dir}}/my-app__engine.py {{view}} {{arg}}"
```

### Chip must equal id (`platform.chip_equals_id`)

```
chip: portal-template
```

### Three start states: live with a key, labelled sample data, setup row only (`api.start_states`)

```
"on_missing_key": "sample"
```

### Approval after every reship (`platform.reapprove`)

```
Settings, Desktop App, User Apps, expand the app, Review and accept
```

### A first word that is not a view (a place, a repo, a host) (`nav.free_text`)

```
=around 94087
```

### One app that takes a typed query AND drills (lookup plus views) (`nav.typed_word_and_drill`)

```
=my-tool customers acme
```

### Buttons on a lookup row (`actions.lookup_row`)

```
"lookup": {"rows": [{"title": "{place.name}", "url": "https://example.com/{place.id}"}]}
```

### An app that only shows sample data (offline, no API) (`sample.offline_only`)

```
"api": {"base_url": "https://example.invalid", "fixture_default": true, "fixture_file": "fixtures.json"}
```

### A text-only lookup result (no empty tile) (`lookup.text_only`)

```
{"kind": "entity_preview", "mode": "selected_row", "bind": {"title": "{{row.title}}", "subtitle": "{{row.subtitle}}", "tiles_above": {"title": "{{row.kpi_label}}", "value": "{{row.kpi_value}}"}, "body": "{{row.body}}", "actions": ["open", "copy"]}}
```

### Shared kit from Bolt (Bolt 182) (`kit.shared`)

```
WANT_SHARED = False   # in the loader block of the app's script: True runs Bolt's shared kit even when it differs from the app's own copy
```
