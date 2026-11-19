# Quick path: build a Bolt App

Read this page only. Every command is `./bolt-apps <command>`, run from the root of the clone. What was run in a real Bolt is in [index.json](index.json) (maintainer drop tests on a main build slightly ahead of 181, not the shipped 181 binary); Windows is unproven; there is no sandbox (a personal script runs as you). More: [CAPABILITIES.md](CAPABILITIES.md) (what works), [ENGINE.md](ENGINE.md) (every config option).

## 1. Pick the template

| You need | Start from | Edit only | Read |
|---|---|---|---|
| A web API with a key: tiles, drill down, detail pane | `portal-template` | `scripts/<id>__config.json`, `scripts/<id>__fixtures.json` | `acme-dash` |
| Charts over rows | `chart-template` | same two | `widget-gallery` |
| A sortable table with totals | `table-template` | same two | `widget-gallery` |
| One word in, one card out | `lookup-template` | same two | itself |
| A typed form that saves rows | `form-template` | `scripts/<id>__config.json` | itself |
| A local file the person names | `file-insights-template` | `scripts/<id>__config.json`, `scripts/<id>__fixtures.json` | itself |
| One command line tool | `cli-wrapper-template` | `scripts/<id>__config.json`, `scripts/<id>__wrap.py` | itself |
| Quick local probes as tiles | `system-glance` | `scripts/<id>__system-glance.py` | itself |
| Several APIs joined | `repo-radar`, `around` | `scripts/<id>__config.json`, `scripts/<id>__fixtures.json`, the one script | itself |
| A service on this computer | `local-service-template` | `utilities/localmodels.yaml` | itself |
| An API no engine template fits | `script-template` | `scripts/<id>__config.json`, `scripts/<id>__fixtures.json`, `scripts/<id>__app.py` | itself |
| Reshape pasted text, no script | `./bolt-apps new <id> --type transform` | its yaml | [AGENTS.md](../../AGENTS.md) |

The edit lists are `edit` in [index.json](index.json). Examples live in `kit/examples/<template>`.

Two shapes, pick one first. **Lookup**: the person types a word (`=my-tool serde`), the app calls the API with it (`{query}`) and shows rows only: no drill, no Back, up to three words. **Views**: tiles, drill, Back, a pane per view; the first word is a view name, never a query, and no API call is made per typed word. A word after a view (`=my-tool customers acme`) only filters that list. "Type a name, see a summary, drill into related lists" works in views mode only if the list endpoint already returns every row ([recipe](ENGINE.md#two-shapes-of-app-lookup-or-views)); if the API must be asked per name, build two apps (two chips).

## 2. Four commands

Needs Node 18+ and Python 3.9+:

```sh run
./bolt-apps new portal-template my-tool --dir ~/my-apps    # copy, rename, make the sample pass
./bolt-apps run ~/my-apps/my-tool --sample                 # see the rows Bolt would show
./bolt-apps check ~/my-apps/my-tool                        # run its test cases
./bolt-apps ship ~/my-apps/my-tool                         # lint, check, pack, verify; prints the .boltpack
```

Edit between `new` and `run`. After editing an engine app's `scripts/<id>__config.json`, regenerate its app file: `cd ~/my-apps/my-tool && python3 scripts/my-tool__engine.py --emit-yaml > utilities/my-tool.yaml` (on an error it prints the problem and exits 1; read it). Then drop the `.boltpack` on the Bolt launcher (never Admin settings), read the review card (self-signed is expected), click Install, click Install again on Bolt's own "Install an unverified Bolt pack?" dialog, then Settings, Desktop, User Apps, expand the app, Review and accept, and type `=my-tool`. `ship` raises the version each time and keeps one signing key in `~/.bolt-apps`. Stuck: `./bolt-apps doctor ~/my-apps/my-tool`.

## 3. Ten hard rules

1. Edit only the files in the table. Never edit `<id>__engine.py`, `<id>__bolt_app_kit.py`, the lock file or a generated `utilities/<id>.yaml`.
2. `id` is lowercase letters, digits and hyphens, and equals the folder name AND the app file's `chip` (`chip_not_id`: Bolt 181 and main look apps up by id, so a different chip is offered but never runs). Every file in `scripts/` is named `<id>__<name>` (`script_not_namespaced`): all apps share one scripts folder and Bolt refuses a file another app owns. Pick a distinctive id: two authors who both ship `weather` still collide.
3. Keys never go in a file, a pack, a row or an error (the kit hides them from API answers within the limits in the table). Use the keychain or `~/.config/<id>/.env` (mode 600). A shell variable does not reach the script under Bolt.
4. Ship live (`api.fixture_default` `false`) unless the app is sample-only by design, such as an offline demo with no API: then set it `true` (recipe: [ENGINE.md](ENGINE.md#an-app-that-only-shows-sample-data-offline-no-api)); `ship` and `doctor` print which start mode you have. Tests use sample data: `"fixture": true` in `check.json`. A placeholder-address template starts as labelled sample data until your key is found (`api.on_missing_key` `sample`); a real app shows one setup row (`setup`).
5. Use only the panes in the table below. Chart types are `line`, `bar` and `sparkline`. Others (pie, donut, area, heatmap, gauge) are not shipped.
6. Icon names are case-sensitive and come from `kit/schema/icons.json` (footer-button icons from a shorter lowercase list).
7. A nav arg is one plain token: no slash. Drill with `nav` (one Enter). A chain to another app, or a chain a script writes on a row, only pre-fills the next command (second Enter); a fixed-text chain to the same app written in the app file runs directly. A row's `pane` works when it names a view whose right pane has mode `selected_row` and kind entity_preview, detail, markdown, json_tree, chart, table or card; it is ignored for mode `list_data`, a view with no right pane, or kind diff, cards or image_grid.
8. A script app is tier 3: personal pack only, never the gallery. It runs as you. Install only code you have read.
9. A list shows at most 50 rows; a failed call is never shown as zero; an old copy shows its age.
10. Say what you did not verify. Today that is everything in real Bolt.

## 4. The rules table

| Limit | Bolt | Kit or engine |
|---|---|---|
| Entries in `presentation.views` | 8 (the overview needs no entry) | 8 (the engine uses 7 plus an overview entry) |
| Tiles pane (`cards`, `bind.layout: tiles`) | one tile per row, at most 24 rows; a row with no number draws an empty "-" tile | send 24 or fewer rows, every row with a number (the default grid layout caps at 500 and needs none; from source, not yet seen in a running 181) |
| Footer buttons | 6 | 3 (Open and Copy count) |
| Footer label | 40 kept, 14 shown (from source, not yet seen in a running 181) | write 14 or fewer |
| Rows in a list | 2000 | 200 in the row schema, 50 from the engine |
| Script timeout | 1 to 60 s, default 10 | engine requests 10 s each, 14 s together |
| Pane kinds with app data | card, markdown, entity_preview, chart, table, cards, detail, json_tree, diff, image_grid | same |
| Panes that cannot show app data | image, color, weather, date, calc (Bolt shows "This app asks for ... pane, which cannot show app data") | do not use |
| Picture in an `entity_preview` pane | `image_url`: a 40 pixel avatar | the same; `hero` (a full-width picture, newer than 181) needs Bolt 182: a 181 refuses the whole pack that uses it. Set `min_bolt_version` 0.1.182 in `bolt-app.json` (see ENGINE.md, Hero picture) |
| `map` pane | draws Bolt's own map, not your rows; any bind key is refused | do not use; open a place with a url action |
| Footer action kinds | url, composer, utility, run | same |
| App file `schema_version` | 1 or 2 (2 makes pane bind mistakes errors) | 1 |
| Listing `bolt-app.json` `schema_version` | 1 | 1 |
| Environment a script sees | HOME, PATH, USER, LOGNAME, LANG, TERM, TMPDIR, TZ, LC_*, XDG_*, SSL_CERT_FILE, SSL_CERT_DIR, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, NODE_EXTRA_CA_CERTS; Bolt sets PYTHONNOUSERSITE, PYTHONDONTWRITEBYTECODE, PYTHONUNBUFFERED, GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT, GIT_OPTIONAL_LOCKS | no names containing TOKEN, KEY, SECRET, PASS, PWD, CRED, AUTH, PRIVATE, SESSION, COOKIE |
| Keys in API answers | Bolt does not scan them | the kit removes the key (as written, URL-encoded, hex, base64, any letter case), `user:password@` in addresses and credential-named query values (`token`, `api_key`, `sig`, `secret`...) from an answer before it is cached or shown |
| What the kit cannot hide | | HTTP Basic base64 at another alignment, HTML entities, colon-separated hex, a key split across lines, a key held as a JSON number, a value URL-encoded twice; a key under 3 characters is refused |
| Sandbox | not shipped: a script runs as you, with your files and network. Bolt does give each run a fresh private working folder (not the app folder), kills its process tree on timeout, and sets CPU and process limits | not shipped |

The same numbers live in `schema/bolt-rules.json`; a test keeps this table equal to it.

## 5. When Bolt says no (Bolt 0.1.181)

| Bolt says or does | Do this |
|---|---|
| After a drop the dialog says `Installed ... Ready to use: your-app-id` | Type `=<chip>`. From the 181 source (not yet seen in a running 181), the list refreshes after a pack install. A file you saved into the User Apps folder by hand needs Reload. |
| The chip is missing | Settings, Desktop App, User Apps, click Reload. A file that failed to load is listed there with the reason. |
| "Not run. Needs your OK" | Press Enter on the app's run row, read what it can do, accept. First run only. |
| What 181 shows after a drop | The review card (self-signed is expected: install), then Bolt's own "Install an unverified Bolt pack?" dialog (click Install). Then Settings, Desktop, User Apps, expand the app, Review and accept; a reship needs it again. |
| HIGH RISK in the install prompt | Normal for a personal app that runs a script (tier 3). Read the permissions, confirm only code you have read. |
| `Bolt did not install this pack because this version, or a newer one, is already installed. Nothing was changed.` (`same_or_older_version`) | `ship` already raises the version. If you packed by hand, pass a higher `--version`. To go back, remove the app first (see the Remove row). |
| `Bolt did not install this pack because one of its files already belongs to another installed pack. Nothing was changed.` (`owned_by_other`; the log has the longer sentence naming the file) | Another installed app owns a script file with that name. Name every file `<id>__<name>` (`./bolt-apps new` does), or remove the other app first. |
| `Bolt did not install this pack because one of its files is inside too many folders. Nothing was changed.` (`too_deep`: a script nested deeper than 8 folders) | Keep scripts flat, directly in `scripts/`. |
| `This pack cannot be installed here. Nothing was changed.` (a refusal with no wording, such as `version_unreadable`) | The reason is in `bolt-startup.log`, search for `user_utils: install pack`. Run `./bolt-apps ship` again. |
| Empty list after install and Enter | Not approved yet: Settings, Desktop, User Apps, expand the app, Review and accept. Every reship changes the files, so approve again. 181 shows an empty list instead of saying so. |
| `chip_not_id` from lint, verify or pack | Set `chip` (app file and `config.json`, then regenerate) to the app's id. |
| `presentation.right_widget.bind.hero: unknown key for a entity_preview pane` (the whole pack is refused) | The pack uses `hero`, which is newer than 181. Install it on Bolt 182 or newer, or remove `hero`. |
| "Bundle rejected" | You dropped it in Admin settings. Drop it on the Bolt launcher or Bolt Apps. |
| Remove | Remove the app in Settings, Desktop, User Apps (the Remove button is on the app's row in 181 (not yet seen on a running 181 build); newer builds also show it in the expanded panel next to Revoke approval). Do not delete files by hand: Bolt keeps an install record, and a hand-deleted file can leave `owned_by_other` behind. Remove deletes the app's YAML and, for a pack's last app, its scripts and install record. If you cannot find a Remove button on your build, tell us which Bolt version you have. If you built apps before a fix was announced for them: remove the app this way, then `./bolt-apps ship` it again. |

If something looks wrong in Bolt (an empty pane, a blank tile, a wrong row), send a screenshot with the app id and what you typed. Written from the 0.1.181 source, not seen in a running 181. Anything that needs a newer Bolt is marked "newer than 181" where it appears.

## 6. What Bolt does with your rows and runs

From the Bolt 0.1.181 source; not run live unless stated. Tell the person what you could not prove.

| Topic | What happens |
|---|---|
| Failure | A non-zero exit discards every row you printed. The person sees `<chip> unavailable: exit code N:` and up to 2 KiB of stderr. To show your own message, print an error row and exit 0; write diagnostics to stderr. |
| Empty | With typed text and no rows Bolt shows "No results". A bare run with no rows shows nothing: print your own row. |
| Typing | Rows of the last run stay; typing filters them (every term in the title or subtitle) and adds a `Run <app> with "..."` row. Always on; `presentation.searchable` does nothing. |
| Drill cache | The launcher keeps the last 8 lists for 5 minutes by typed input, so a drill, Back or Refresh to a recent input may not run your script again. |
| First word | A first word that is not a declared view (a place, a repo, a host) is drawn by the app-level right pane, which must tolerate rows with no value (a `selected_row` preview). `check` runs one sample case like that. |
| Compare (`diff`) | Draws only the text its bind gives it. Show what changed in a `detail` pane: Before, After, Change. |
| Nav needs | `view_arg` bound to `query.word(N)` with N at most 8, and every `query.word` arg before it needs a one-token default such as `none` (not `-`). Otherwise no row can drill, silently. |
| Keys | Esc and Left go Back, Right drills (caret at the end), 16 deep. |
| Variables | `{{limit}}` is always 24 and does not cap rows. `{{press}}` is the id of the clicked run action, else `-`. `{{outname}}` is for bundled apps only. A value that would begin an argument with `-` is refused, except after `--`. |
| Files | `emits: File` plus a row `path` starting `/`, `~/` or a drive letter opens as a file (a trailing slash is a folder). |
| Detail pane | With no `bind.fields` it lists every key of the row, including `nav`, `actions` and `kpi_*`. Always give `fields`. |
| Entity preview | `fields[].kind` is text, badge, chips, branch or diff; `tiles_above` draws only for a number. `primary: true` on one action takes Enter (at most one). A run action may carry an `icon`; a url action never does. |
| Chart | A row without the `y` field is skipped, so one pane can mix chart rows and plain rows. |
| Badges | In the list, tone `success`, `danger`, `warn` or `info` is coloured, any other is grey; at most 4 per row. `category` only re-selects the row after Back. |

## 7. Where things stand

Sharing common code: on 181 every pack carries its own kit copy, so a kit fix means re-vendoring and reshipping. Bolt 182 adds a shared kit (ENGINE.md, "Shared kit"); it is not yet proven in a real Bolt, and an old app keeps its own copy until reshipped.

Sample mode (`run --sample`, `check`) needs no key and no network. Live mode: put the key in the keychain or the `.env` file, then `run --live`. Not shipped: confinement of scripts, native MCP (a script can call one tool over stdio, tested only against a stand-in), Windows runs. The `permissions` block in an app file is shown at install and not enforced.
