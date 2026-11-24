# Bolt Apps authoring kit: design

Status: built for Python (`bolt_app_kit`, version in `bolt_app_kit.__version__`), with the row contract and `bolt-apps check`. This repository is separate from the Bolt binary and the gallery is closed, so the kit ships as source and docs here and changes no product code.

## 1. Goals and non-goals

**Goal.** An app author writes data and wiring: which commands to read, how to parse them, which rows to show. The kit does the rest: formatting, row structure, JSON output, text safety, deadlines, caching, and a test harness that runs the script the way the launcher does.

Why: the same defects keep coming back when each app reimplements these things. The kit makes each one impossible to write by accident and cheap to test.

| # | Defect class | Where the kit stops it | Test |
|---|---|---|---|
| 1 | A failed or hung probe shown as a clean zero, then cached | `Probe` is unread, never 0; `Cache.put` refuses failures | `test_failed_probe_is_unread_not_zero`, `test_never_caches_failure` |
| 2 | Non-numeric tile value shows "-" and "no value" | `tile()` raises on a non-number; `None` means no tile; schema and `check` enforce it | `test_non_numeric_tile_value_raises`, `tile_without_number` |
| 3 | "All clear" while sections were not read | `headline()` cannot return all clear with an unread probe | `test_headline_refuses_all_clear_when_unread` |
| 4 | Non-zero exit with no output treated as success; legit exit 1 | `run()` ok only for `ok_rcs`; `empty_ok_rcs` is the explicit opt-in | `test_nonzero_exit_*`, `test_legit_exit_one_*` |
| 5 | Launcher behaves differently from a shell | `check` runs in a clean subprocess: minimal environment, temp HOME, controlled PATH | `the script runs with an empty environment` |
| 6 | A hung command runs past the app's `bridge.timeout_seconds` | One `Deadline` (14 s) shared by every command; `run_parallel` abandons slow tasks | `test_shared_deadline_*`, case "every command hangs" |
| 7 | `{{ }}` re-expanding, bidi, zero-width, tag and control characters | `clean_text`, `neutralise_braces`; every builder applies them | `test_hostile_text_is_neutralised`, `text_unsafe`, `text_braces` |
| 8 | Footer: more buttons or longer labels than [the rules table](../kit/examples/QUICKSTART.md#4-the-rules-table) allows | `row()` and `_action()` raise; schema and `check` enforce | `test_footer_limit_*`, `label_too_long` |
| 9 | Rounding differs between display, thresholds and badges | `rnd()` = floor(x+0.5), used by every formatter | `test_rounding_one_rule` |
| 10 | Cache: unchecked shape, symlinks, temp files, no pruning | `Cache`: shape check, `lstat`-checked directory, `O_EXCL|O_NOFOLLOW`, pruning | `CacheTests` |
| 11 | Origins and hosts truncated generically | `host_label` elides from the left and keeps the registrable domain | `test_origin_never_through_generic_truncation` |
| 12 | Env-driven test hooks in a shipped script | None exist; a source scan test fails on any `os.environ` or `getenv` use except the PATH lookup and parent-environment copy in `probe.py` and the key lookup in `secrets.py` (it does not catch every possible indirect hook) | `test_no_env_driven_hooks` |

**Non-goals.** Enforcing an app's permissions at run time (that is the runtime's job). The gallery or its index. A JavaScript or shell kit (described in section 8, not built). Changing Bolt's manifest format. Running the real launcher.

## 2. The row contract (language neutral)

`kit/schema/row.schema.json` is a JSON Schema for what a script prints: an array of rows (at most 200). It mirrors what the launcher accepts: its row mapper, its row-action sanitizer, its row-nav sanitizer and its tile reader. It is stricter than the launcher where the launcher silently drops or hides things.

| Part | Fields | Rule |
|---|---|---|
| Row | `title` (required, 160), `subtitle` (200), `body` (markdown, 8000), `icon`, `pane`, `category` (Bolt uses it only to re-select the row after Back; it draws no group heading), `url` (http/https), `copy_text` | Free extra fields are scalars (string, number, boolean) a manifest binds as `{{row.x}}`. |
| Tile | `kpi_label`, `kpi_value`, `kpi_unit` (4), `kpi_max`, `kpi_note`, `kpi_foot` (80), `kpi_badge` | `kpi_value` and `kpi_max` are a JSON number or `""`. A tile with a label but no number is invalid. |
| Badges | `badges`: up to 4 of `{label, tone}` | |
| Actions | `actions`: kinds `url`, `composer`, `utility` (the `run` kind exists only for footer actions written in the app file). A `url_template` must start with `http://` or `https://` and a literal host, so a placeholder never supplies the scheme or host | Footer count and label length: [the rules table](../kit/examples/QUICKSTART.md#4-the-rules-table) (the kit's own limit, below Bolt's); a row adds at most the kit limit minus `manifest_actions`. |
| Nav | `{"back": true}` or `{"view": token, "arg": token}` | Tokens match the launcher's `NAV_ARG_RE`. A nav row carries no actions. |
| Icon | one of the launcher's icon names | See below. |

**Icons are generated, not typed.** The launcher resolves icon names in its icon map. `kit/schema/gen-icons.mjs <the launcher's icon map file>` writes `kit/schema/icons.json`, the enum in `row.schema.json` and `kit/python/bolt_app_kit/icons_data.py`. `--check` exits 1 on drift. The Node tests assert that the three generated files agree and that the parser reads the shapes of the icon map; `--check` against the launcher source is run by hand. An unknown icon makes the launcher fall back to a generic plug, so the kit rejects it at build time.

## 3. The Python library: `bolt_app_kit`

Pure standard library, Python 3.9+, no environment-driven test hooks (the only variables it reads are PATH, a copy of the parent environment for `run()`, and the key names an app gives `get_secret`). CI tests 3.9 (the minimum, on ubuntu-22.04, because the newest runner image has no 3.9) and 3.13. Located at `kit/python/bolt_app_kit/`.

| Area | API |
|---|---|
| Output | `emit(rows)` validates against the schema, prints compact ASCII JSON, exits without waiting for stray threads. An invalid payload prints one error row and exits 3. Under Bolt that row is never seen: a non-zero exit discards every printed row and the person sees a row titled `<chip> unavailable` whose subtitle is `exit code 3: ` followed by the script's stderr (cut at 2 KiB, counted in bytes, with `(truncated)` added when it is cut). A run that times out shows `<chip> timed out` instead, with the timeout and stderr in the subtitle. The row is what `check` and a terminal show. `validate_rows(rows)` returns the problems. |
| Builders | `row` (with `badges`), `tile`, `safe_row` (retries after dropping optional data fields in a fixed order, so valid fields can be dropped too), `safe_tile` (returns no tile for an invalid value), `back_row`, `refresh_row`, `note_row`, `error_row`, `unsupported_row`, `action_copy`, `action_chain`, `action_url`, `kv_fields`, `chips`. Contract violations raise `KitError` at build time. |
| Formatters | `rnd`, `fmt_num`, `fmt_pct`, `fmt_bytes`, `fmt_duration`, `fmt_count`, `fmt_time`. One rounding rule: `floor(x + 0.5)`. A missing value is the word `unknown`, never `0`. |
| Text | `clean_text` (control, format, bidi, zero-width, tag, surrogate, private-use, line separators, blank fillers removed; stacked marks capped), `clean_lines`, `neutralise_braces`, `text`, `elide_end`, `elide_left`, `host_label`, `safe_text`, `safe_copy`, `copy_ok`, `host_full` (the whole cleaned host, to show next to a shortened `host_label`). |
| Probes | `Deadline`, `run`, `probe`, `Probe`, `run_parallel`, `os_name`, `which`. |
| Cache | `Cache(app, ttl, shape)` with `get`, `put`, `age` (seconds since the entry was stored), `prune`. |
| Keys | `get_secret(app_id, name)` returns a `Secret` (`value`, `source`, and `problem` when a key was found but refused, for example a file other users can read or a key too short to hide); `env_file_path`, `setup_hint` (a one-line setup that never contains a key); `redact` for error text and `redact_tree` for a parsed answer before it is cached, logged or shown. |
| Hero image | `hero_fields(image)` splits a picture into row fields of at most 4,000 characters; `hero_src_template(parts)` is the matching `bind.hero.src` for the app file. |
| Headline | `headline(probes, findings)` returns text, tone and `all_clear`; an empty probe set is never all clear. |

**Probes.** `run(cmd, deadline=None, timeout=None, dirs=None, ok_rcs=(0,), empty_ok_rcs=())` takes an argv list only (a string is a `TypeError`: there is no shell). It returns `(ok, rc, out)` and never raises for a missing program, a bad exit or a timeout; `.timed_out` and `.missing` say why. `dirs` resolves the program only in those directories, ignoring PATH. The child runs in its own session so a timeout kills the whole tree. By default the child gets the parent environment with `LC_ALL=C` so output is not translated; pass `env={}` for an empty one. `probe(name, cmd, parse)` returns a `Probe` that is **unread** when the command failed, timed out, produced nothing when output is required, or the parser returned `None` or raised. Its `value` is then `None`: there is nothing to fake.

**Defaults that fail safe.** `probe()` treats empty output as unread unless `require_output=False`; `run()` with no deadline and no timeout still uses a 14 s budget; output over `max_bytes` is a failure, not a truncated success. The 14 s budget assumes the app file sets `bridge.timeout_seconds` to 20 or more: Bolt's limit is 1 to 60 s with a default of 10 (`schema/bolt-rules.json`, `timeouts`). `system-glance` sets 20 s and `portal-template` sets 25 s; some other examples use shorter limits. `validate_rows` (used by `emit`) also enforces the rules a schema cannot say: a tile with text needs a number, the footer count including the manifest's actions, and a nav row has no actions.

**Hosts.** `host_label` never cuts inside a label: it shows the whole host, or drops whole leading labels, or returns `(host too long)` (show `host_full()` next to it). It has no full public-suffix list: it knows common two-part suffixes (`co.uk`, `com.au`) and a short list of hosting suffixes (`github.io`, `pages.dev`, ...). Punycode (`xn--`) hosts are shown raw and never cut. Scheme and port are not shown, so do not use it where the scheme or port is the point.

**Known limits.** The kit counts text limits in code points. Bolt does not cut a row's title or subtitle itself; it caps the number of rows (2000), action labels (40 code points), links (2048 characters) and badges (4). Removing unassigned characters depends on the Python Unicode version. Brace neutralising is ASCII only. The windows tree kill needs `taskkill` on PATH or in `C:\Windows\System32`.

**Headline.** `headline({"disk": p1, "ports": p2}, findings=0)` says `Not all sections read: ports` when any probe is unread, then the finding count, and only then `All clear`.

**Cache.** The directory is `~/.bolt-apps/cache/<app>`. It is created `0700`, checked with `lstat` (not a symlink, ours, not group or world writable); if it fails the check the cache turns itself off. Reads use `O_NOFOLLOW`, cap the size and require the caller's `shape(value)` to pass. Writes go to an `O_EXCL|O_NOFOLLOW` temp file and are renamed in. Expired entries and stray temp files are pruned and the count is capped. `put` refuses `None` and `ok=False`, so a failure is never cached.

**Copy text.** `safe_copy` is the allowlist from `bolt_safenet.py`: NFKC, letters, digits and a short punctuation set, one `- ` bullet per line so the first shell token is never a command. `action_copy(..., safe=False)` is for a bare command a person will run themselves; it is still cleaned.

**Script-app scaffold (0.3.11).** What every script app used to copy into its own file lives once in the kit (`bolt_app_kit/scaffold.py`): `Fail`, `s`, `json_loader(HERE, _PFX)`, `split_args(argv, FILE_WORDS)`, `fixture_mode(os.environ.get("BOLT_APP_FIXTURE"), default)`, `back_to_overview`, `run_guarded(main, argv, debug)` (a crash is one plain row, never a traceback), `indent`, `tile_bind`, and `bridge_head` / `bridge_yaml` for the head of a generated app file. An app keeps only its own logic and its own panes. It changes no row and no app file: `check` output and goldens of every example are identical before and after. An app on an older kit keeps its copies and runs unchanged.

## 4. Cross-platform apps

### Facts (as Bolt behaves)

- The manifest takes a command per OS: `bridge.command.macos | linux | windows`, each optional, at least one required (the launcher's manifest contract and bridge validation). The shipped `sys.yaml` and `posture.yaml` use `python3` on macOS and Linux and `python` on Windows.
- The manifest has no `platforms` or `requires` field. `requires` is explicitly refused for a User App (the launcher rejects it), and unknown fields are denied.
- Nothing declares or checks the interpreter: a missing `python3` shows up as a failed command at run time.

### Authoring shapes

An author can ship either, with the same row contract:

1. **One source, per-OS wiring.** One script; a table maps each OS to its commands (see `kit/examples/system-glance`). `os_name()` is the only OS switch. Best when the logic is shared and only the commands differ.
2. **Per-OS implementations.** `bridge.command.windows` points to a different script (for example PowerShell) than macOS and Linux. The row contract and the fixtures are the shared part.

### Declaring support (proposal, not part of this task)

`bolt-app.json` now accepts, and `bolt-apps lint` and `check` validate:

```json
"platforms": ["macos", "linux"],
"requires": [{ "interpreter": "python", "min_version": "3.9" }]
```

`requires[].interpreter` is one of `python`, `node`, `sh`, `powershell`; `platforms` is optional per entry. **Bolt does not read these yet.** Using them (hide the app on an unsupported OS with a plain reason, check the interpreter at install, record `platforms` in the pack manifest) needs a change in the launcher's manifest contract and its UI. That is a proposal for the runtime. Until then they are documentation that the toolkit validates (`verify` also skips the missing-command warning for a system that `platforms` leaves out), and the script protects itself with `unsupported_row`.

### The real problem is the interpreter

`python3` is not present by default on Windows, and a clean macOS only has a stub that prompts for developer tools. Options, honestly:

| Option | Works today | Cost |
|---|---|---|
| **A. Declared interpreters** (`requires`) | Authoring and docs yes; enforcement needs the runtime change above | The user installs Python; a missing one gives a plain message instead of a failed command |
| **B. Shell fallbacks / single binary** (`sh`, PowerShell, or a compiled helper) | Yes, no new runtime | PowerShell and sh differ a lot; a compiled helper means a build per OS and a supply-chain review |
| **C. A Bolt-provided confined runtime** (WASM or an embedded script engine); not built | No | Big engineering; but it removes the interpreter problem, and is the natural place to enforce the permission and confinement roadmap |

**Recommendation.** Do A now: declare `platforms` and `requires`, validate them in the toolkit (done), and have the runtime show a plain reason (proposal). Use B only for tiny apps where a POSIX `sh` or PowerShell one-liner is honest. Plan C as the long-term answer, because it fixes the interpreter and gives confinement in one move; design the kit contract so an app written today (JSON rows out) moves to a sandboxed runtime unchanged.

### Pitfalls the kit absorbs

| Pitfall | Kit behaviour |
|---|---|
| `python` on Windows, `python3` elsewhere | Stays in the manifest per OS; `os_name()`, `which()` for the script |
| UTF-8 stdout | `emit` writes ASCII-only JSON, safe on any console code page |
| Path separators and quoting | argv lists only, never a shell string; `which(..., os_=)` tries `.exe .cmd .bat .com` on Windows |
| Killing a process tree on timeout | POSIX: kill the process group (own session). Windows: `taskkill /PID n /T /F`. Tested on POSIX; the Windows branch is tested with a stub `taskkill` |
| No `lsof`, `arp`, `pmset` on Windows | Per-OS command table; an unavailable command is an unread probe, not a crash |
| Line endings | `clean_text` and `clean_lines` normalise `\r\n` and `\r` |
| Locale-dependent output (a German `ipconfig` was a real finding) | `LC_ALL=C` by default on POSIX. Windows tools ignore it: prefer structured sources (PowerShell `ConvertTo-Json`, `netsh` with fixed fields) and never match on translated words |

Not absorbed: the Windows OEM code page for some console tools (decode with `encoding=` per command).

## 5. The test harness: `bolt-apps check`

`bolt-apps check <app> [--json] [--os macos|linux|windows] [--case text] [--shared] [--update-golden]` runs when the app folder has a `check.json`. (Snippet, search and transform apps still go through Bolt's own engines, which are not published; `check` on them says so.)

`--case text` runs only the cases whose name contains the text. `--shared` offers a fresh export of this repository's kit to the selected cases, as Bolt offers its shared kit (`kit export-shared`). The loader chooses which copy to use. If the script does not load the exported copy, the case fails with `shared_kit_not_used`.

**Run it only on code you have read.** `check` executes the app's script and interpreter on your machine. The minimal environment, temp HOME and stub PATH make the result repeatable; they are not a sandbox. A script can still read your real home directory, call tools by absolute path and use the network. Paths named in `check.json` must stay inside the app folder (`kit vendor` refuses anything else).

**What it does, per case:**

1. Builds a temp directory with a **stub command** for each recorded output (`fixtures/<os>/<cmd>.out`, optional `<cmd>.rc`) and a temp HOME.
2. Runs the script in a **clean subprocess**: `PATH` points to the stub directory, `HOME` and the working directory are the temp HOME, and `USER` and `LOGNAME` are `bolt`. The harness also sets `runner_env.fixed` from `schema/bolt-rules.json`, `BOLT_APP_FIXTURE` when fixture mode is set to true or false, and `BOLT_APP_SHARED_DIR` with `--shared`. Case `env` entries in `check.json` must match `[A-Z_][A-Z0-9_]*` and cannot override the harness values. A command with no stub is "not found", so the script must handle a missing tool.
3. For `--os X`, runs only the cases for OS X and starts the script with the Python platform set to X (done by the harness wrapper, never by the script), so the script's `os_name()` picks that OS's commands.
4. **Hung-command mode**: `"hang": ["df", "lsof"]` makes those stubs sleep. The case asserts the whole run stays under its time budget (`expect.max_seconds`, default 18 s) and the output still validates and does not say all clear. Separately, `check` kills the subprocess if it is still running after 23 s, regardless of the case budget or the app file's `bridge.timeout_seconds`.
5. **Hostile-data fuzz**: `"hostile": true` replaces `@@HOSTILE@@` in the fixtures with a payload (bidi, zero-width, tag, line separator, bell, `{{x}}`). Every case already scans all output for such characters and for `{{`/`}}`.
6. **Golden snapshots**: the rows must equal `golden/<name>.json`. `--update-golden` writes it; review the diff.
7. **Schema validation** of every output, and the label, footer (the kit limit minus manifest actions, `manifest_actions` in `check.json`) and numeric-tile rules, with the numbers in [the rules table](../kit/examples/QUICKSTART.md#4-the-rules-table).
8. Expectations per case: `text_present`, `text_absent`, `max_seconds`, `exit`, `min_rows`, `view_fallback`.
9. **Kit guard**: the `bolt_app_kit` beside the script must match its lock (`kit_modified`), and match this toolkit's kit when the versions are equal (`kit_diverged`). An older pinned version is an error (`kit_outdated`) unless `check.json` sets `allow_outdated_kit` after the older kit was reviewed. The kit directory must hold exactly the kit's files: a symlink, a subdirectory, a `.so`, `.pyd` or `.pyc`, or any extra file fails `kit_modified` (only `__pycache__` contents are ignored). Paths in `check.json` may not pass through a symlink, and `kit vendor` only replaces a real directory named `bolt_app_kit` inside the app folder. The lock is not signed, so this catches accidents and unreviewed edits, not an author who rewrites the lock and the version on purpose; the pack signature (section 6) is what binds the kit to a release.

**Built:** all of the above, on macOS or Linux hosts, for Python scripts.

**Not built:**
- Running on a Windows host (the stubs are `sh` scripts).
- Real behaviour of another OS. `--os windows` from a Mac tests the app's own logic against recorded output; it is reported as "Fixture-tested only". Path handling, encodings, real tools and the real tree kill are not exercised.
- The real launcher: row mapping, nav, the footer, tile rendering. `check` approximates the launcher's rules from its source; it can be wrong when the launcher changes.
- Interpreters other than the one in `check.json`, minimum-version checks, shell or Node scripts.
- Property-based fuzzing beyond the fixed hostile payload; parallel case execution.
- A fixture recorder.

**Follow-up (maintainer, not done here):** the fleet has real Linux and Windows machines. The same fixtures can be replayed there live by running the app against the real tools and diffing the rows against the goldens, which turns "fixture-tested only" into "run on that system".

## 6. How an app gets the kit

`bolt-apps kit vendor <app>` copies the kit (`*.py` and the schema) into the app's `scripts/bolt_app_kit/` and writes `scripts/bolt_app_kit.lock.json`: `{ "name", "version", "sha256" }`, where the hash covers the path and content of every file in the kit directory. Python puts the script's own directory on `sys.path`, so `import bolt_app_kit` just works with no install.

**Flat mode (single file).** Bolt keeps every installed app's scripts in ONE shared folder and refuses a file whose path another app already owns (`owned_by_other`), so every file an app ships is named `<app id>__<name>` (`script_not_namespaced` otherwise; ids are unique and hold no underscore, so two apps can never share a name). Also, the approval hash covers only files the command names as `{{scripts_dir}}/<file>`, so a package folder of helpers would sit outside what the person approved. `bolt-apps kit vendor --flat <app>` therefore writes the whole kit as ONE file, `scripts/<app id>__bolt_app_kit.py`, and points `check.json` `kit` at it (and removes an older folder build). The file embeds the kit's own module sources and builds the package `bolt_app_kit` in memory on import, so the code that runs is the kit's, unchanged; `import bolt_app_kit` works with no install. The lock (`name`, `version`, `flat: true`, `sha256` of the file) is `bolt_app_kit.lock.json` beside `check.json`: author side, never packed. The pack signature then covers the kit like any script. `check` sets `sys.dont_write_bytecode` so no `__pycache__` appears next to the scripts.

**Divergence guard (both modes):** `check` fails `kit_modified` if the vendored files differ from the lock (edited by hand; in flat mode also a `bolt_app_kit/` folder beside the file, which Python would import instead), `kit_diverged` if the lock claims this toolkit's version but the files differ from a fresh build, and `kit_outdated` if the app is pinned to an older version.

`bolt-apps pack --personal` packs a single-file-script app for your own use (all per-OS commands in one app file, one signature). `platforms`, `requires` and `min_bolt_version` travel in the `listing` of the pack's signed `bundle.json`, not in the individual app manifests, and Bolt does not read them. The listing comes from `bolt-app.json`, with `tier` and `permissions` recomputed from the app files. A kit app packs when the kit is vendored flat (`kit vendor --flat`). `verify` and `lint` count a script as used when an app file runs it, when a used `.py` script imports it, or when a used `.json` file names it in a quoted string (for example `config.json` naming `fixtures.json`); a script nothing uses is still `script_unused`. The gallery still takes tier 1 and 2 only.

**Apps bundled with the desktop app.** The sample apps that ship inside the desktop bundle do not use the kit yet. Bolt 182 ships the shared kit folder and sets `BOLT_APP_SHARED_DIR` for script apps, but no bundled sample imports it. They could consume it the same way: a sync script copies the pinned kit into their `scripts/` and a guard test fails when the copy differs from its lock. Not part of this task; no launcher file is touched.

## 7. Versioning and upgrades

Semantic versions in `bolt_app_kit.__version__`. While the version is `0.x`, a minor bump may change an API; each change is listed in the release note. Rows carry no version of their own. Compatibility is the manifest `schema_version` (1 or 2) and the kit `api` number; a new optional field is not breaking, a new required field is. To upgrade an app: run `bolt-apps kit vendor <app>`, run `check --update-golden`, review the golden diff, run `check`. The lock records what the app was tested with.

## 8. Other languages

The contract is language neutral: the JSON Schema and `kit/conformance/cases.json` (inputs and expected outputs for `fmt_pct`, `fmt_bytes`, `fmt_duration`, `fmt_count`, `fmt_time`, the text functions, the tile rule and the validation cases; `rnd` and `fmt_num` have none). Any implementation passes the same fixtures.

| Kit | State |
|---|---|
| Python | Built. Runs `cases.json` in `kit/python/tests/test_conformance.py` |
| TypeScript/Node | Not built. Planned second. Same `cases.json` and schema; it must pass the same cases and the same `check` fixtures, so the two kits are tested identically |
| Shell | Not built. Planned: a tiny emitter or a documented printf pattern for apps that only print a few rows, with no formatters. There is no `bolt-apps emit` command yet |

The JS validator inside `check` already runs the `validate` cases from `cases.json`, which shows the fixtures are portable.

## 9. Out of scope

Not built: permissions enforcement and confinement (the runtime), the gallery and its index, a JavaScript kit, Windows hosting for `check`, a reviewed route for publishing script apps (a personal pack is self-signed).
