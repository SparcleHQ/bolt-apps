# Bolt Apps authoring kit: design (v0.1)

Status: v0.1 built for Python, the row contract and the first slice of `bolt-apps check`. This repository is separate from the Bolt binary and the gallery is closed, so the kit ships as source and docs here and changes no product code.

## 1. Goals and non-goals

**Goal.** An app author writes data and wiring: which commands to read, how to parse them, which rows to show. The kit does the rest: formatting, row structure, JSON output, text safety, deadlines, caching, and a test harness that runs the script the way the launcher does.

Why: the same defects keep coming back when each app reimplements these things. The kit makes each one impossible to write by accident and cheap to test.

| # | Defect class | Where the kit stops it | Test |
|---|---|---|---|
| 1 | A failed or hung probe shown as a clean zero, then cached | `Probe` is unread, never 0; `Cache.put` refuses failures | `test_failed_probe_is_unread_not_zero`, `test_never_caches_failure` |
| 2 | Non-numeric tile value shows "-" and "no value" | `tile()` raises on a non-number; `None` means no tile; schema and `check` enforce it | `test_non_numeric_tile_value_raises`, `tile_without_number` |
| 3 | "All clear" while sections were not read | `headline()` cannot return all clear with an unread probe | `test_headline_refuses_all_clear_when_unread` |
| 4 | Non-zero exit with no output treated as success; legit exit 1 | `run()` ok only for `ok_rcs`; `empty_ok_rcs` is the explicit opt-in | `test_nonzero_exit_*`, `test_legit_exit_one_*` |
| 5 | Launcher behaves differently from a shell | `check` runs in a clean subprocess: empty environment, temp HOME, controlled PATH | `the script runs with an empty environment` |
| 6 | A hung command blows the 20 s bridge limit | One `Deadline` (14 s) shared by every command; `run_parallel` abandons slow tasks | `test_shared_deadline_*`, case "every command hangs" |
| 7 | `{{ }}` re-expanding, bidi, zero-width, tag and control characters | `clean_text`, `neutralise_braces`; every builder applies them | `test_hostile_text_is_neutralised`, `text_unsafe`, `text_braces` |
| 8 | Footer: more than 3 buttons, labels over 14 characters | `row()` and `_action()` raise; schema and `check` enforce | `test_footer_limit_*`, `label_too_long` |
| 9 | Rounding differs between display, thresholds and badges | `rnd()` = floor(x+0.5), used by every formatter | `test_rounding_one_rule` |
| 10 | Cache: unchecked shape, symlinks, temp files, no pruning | `Cache`: shape check, `lstat`-checked directory, `O_EXCL|O_NOFOLLOW`, pruning | `CacheTests` |
| 11 | Origins and hosts truncated generically | `host_label` elides from the left and keeps the registrable domain | `test_origin_never_through_generic_truncation` |
| 12 | Env-driven test hooks in a shipped script | None exist; a source scan test fails if the kit names an environment variable (it does not catch every possible indirect hook) | `test_no_env_driven_hooks` |

**Non-goals (v0.1).** Enforcing an app's permissions at run time (that is the runtime's job). The gallery or its index. A JavaScript or shell kit (described in section 8, not built). Changing Bolt's manifest format. Running the real launcher.

## 2. The row contract (language neutral)

`kit/schema/row.schema.json` is a JSON Schema for what a script prints: an array of rows (at most 200). It mirrors what the launcher accepts, from `bolt-pwa` `utility-rows.ts` (`mapBridgeRows`), `user-app-actions.ts` (`sanitizeRowActions`), `userAppNav.ts` (`sanitizeRowNav`) and `kpiTile.ts`. It is stricter than the launcher where the launcher silently drops or hides things.

| Part | Fields | Rule |
|---|---|---|
| Row | `title` (required, 160), `subtitle` (200), `body` (markdown, 8000), `icon`, `pane`, `category`, `url` (http/https), `copy_text` | Free extra fields are scalars (string, number, boolean) a manifest binds as `{{row.x}}`. |
| Tile | `kpi_label`, `kpi_value`, `kpi_unit` (4), `kpi_max`, `kpi_note`, `kpi_foot` (80), `kpi_badge` | `kpi_value` and `kpi_max` are a JSON number or `""`. A tile with a label but no number is invalid. |
| Badges | `badges`: up to 4 of `{label, tone}` | |
| Actions | `actions`: kinds `url`, `composer`, `utility` | Up to 3 in the schema; a row adds at most `3 - manifest actions` (2 when the manifest declares Copy). `label` 1 to 14 characters. |
| Nav | `{"back": true}` or `{"view": token, "arg": token}` | Tokens match the launcher's `NAV_ARG_RE`. A nav row carries no actions. |
| Icon | one of the launcher's icon names | See below. |

**Icons are generated, not typed.** The launcher resolves icon names in `bolt-pwa/src/lib/components/ui/utilityIconMap.ts` (`UTILITY_ICON_MAP`). `kit/schema/gen-icons.mjs <that file>` writes `kit/schema/icons.json`, the enum in `row.schema.json` and `kit/python/bolt_app_kit/icons_data.py`. `--check` exits 1 on drift. The Node tests assert that the three generated files agree, and run `--check` against the launcher source when that checkout is present. An unknown icon makes the launcher fall back to a generic plug, so the kit rejects it at build time.

## 3. The Python library: `bolt_app_kit`

Pure standard library, Python 3.9+, no environment-driven behaviour. CI tests 3.9 (the minimum, on ubuntu-22.04, because the newest runner image has no 3.9) and 3.13. Located at `kit/python/bolt_app_kit/`.

| Area | API |
|---|---|
| Output | `emit(rows)` validates against the schema, prints compact ASCII JSON, exits without waiting for stray threads. An invalid payload prints one error row and exits 3. `validate_rows(rows)` returns the problems. |
| Builders | `row` (with `badges`), `tile`, `back_row`, `refresh_row`, `error_row`, `unsupported_row`, `action_copy`, `action_chain`, `action_url`, `kv_fields`, `chips`. Contract violations raise `KitError` at build time. |
| Formatters | `rnd`, `fmt_num`, `fmt_pct`, `fmt_bytes`, `fmt_duration`, `fmt_count`, `fmt_time`. One rounding rule: `floor(x + 0.5)`. A missing value is the word `unknown`, never `0`. |
| Text | `clean_text` (control, format, bidi, zero-width, tag, surrogate, private-use, line separators, blank fillers removed; stacked marks capped), `clean_lines`, `neutralise_braces`, `text`, `elide_end`, `elide_left`, `host_label`, `safe_text`, `safe_copy`, `copy_ok`. |
| Probes | `Deadline`, `run`, `probe`, `Probe`, `run_parallel`, `os_name`, `which`. |
| Cache | `Cache(app, ttl, shape)` with `get`, `put`, `prune`. |
| Headline | `headline(probes, findings)` returns text, tone and `all_clear`; an empty probe set is never all clear. |

**Probes.** `run(cmd, deadline=None, timeout=None, dirs=None, ok_rcs=(0,), empty_ok_rcs=())` takes an argv list only (a string is a `TypeError`: there is no shell). It returns `(ok, rc, out)` and never raises for a missing program, a bad exit or a timeout; `.timed_out` and `.missing` say why. `dirs` resolves the program only in those directories, ignoring PATH. The child runs in its own session so a timeout kills the whole tree. By default the child gets the parent environment with `LC_ALL=C` so output is not translated; pass `env={}` for an empty one. `probe(name, cmd, parse)` returns a `Probe` that is **unread** when the command failed, timed out, produced nothing when output is required, or the parser returned `None` or raised. Its `value` is then `None`: there is nothing to fake.

**Defaults that fail safe.** `probe()` treats empty output as unread unless `require_output=False`; `run()` with no deadline and no timeout still uses a 14 s budget; output over `max_bytes` is a failure, not a truncated success. `validate_rows` (used by `emit`) also enforces the rules a schema cannot say: a tile with text needs a number, the footer count including the manifest's actions, and a nav row has no actions.

**Hosts.** `host_label` has no full public-suffix list: it knows common two-part suffixes (`co.uk`, `com.au`) and a short list of hosting suffixes (`github.io`, `pages.dev`, ...). Punycode (`xn--`) hosts are shown whole and raw. Scheme and port are not shown, so do not use it where the scheme or port is the point.

**Known limits.** Text limits count code points, the launcher counts UTF-16 units. Removing unassigned characters depends on the Python Unicode version. Brace neutralising is ASCII only. The windows tree kill needs `taskkill` on PATH or in `C:\Windows\System32`.

**Headline.** `headline({"disk": p1, "ports": p2}, findings=0)` says `Not all sections read: ports` when any probe is unread, then the finding count, and only then `All clear`.

**Cache.** The directory is `~/.bolt-apps/cache/<app>`. It is created `0700`, checked with `lstat` (not a symlink, ours, not group or world writable); if it fails the check the cache turns itself off. Reads use `O_NOFOLLOW`, cap the size and require the caller's `shape(value)` to pass. Writes go to an `O_EXCL|O_NOFOLLOW` temp file and are renamed in. Expired entries and stray temp files are pruned and the count is capped. `put` refuses `None` and `ok=False`, so a failure is never cached.

**Copy text.** `safe_copy` is the allowlist from `bolt_safenet.py`: NFKC, letters, digits and a short punctuation set, one `- ` bullet per line so the first shell token is never a command. `action_copy(..., safe=False)` is for a bare command a person will run themselves; it is still cleaned.

## 4. Cross-platform apps

### Facts (verified in Bolt's source)

- The manifest takes a command per OS: `bridge.command.macos | linux | windows`, each optional, at least one required (`bolt-native` `contract.rs`, `BridgeCommand` and `validate_bridge`). The installed `sysx.yaml` and `posturex.yaml` use `python3` on macOS and Linux and `python` on Windows.
- The manifest has no `platforms` or `requires` field. `requires` is explicitly refused for a User App (`contract.rs` rejects it), and unknown fields are denied.
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

`requires[].interpreter` is one of `python`, `node`, `sh`, `powershell`; `platforms` is optional per entry. **Bolt does not read these yet.** Using them (hide the app on an unsupported OS with a plain reason, check the interpreter at install, record `platforms` in the pack manifest) needs a runtime change in `bolt-native` `contract.rs` and the launcher. That is a proposal for the runtime. Until then they are documentation that the toolkit validates, and the script protects itself with `unsupported_row`.

### The real problem is the interpreter

`python3` is not present by default on Windows, and a clean macOS only has a stub that prompts for developer tools. Options, honestly:

| Option | Works today | Cost |
|---|---|---|
| **A. Declared interpreters** (`requires`) | Authoring and docs yes; enforcement needs the runtime change above | The user installs Python; a missing one gives a plain message instead of a failed command |
| **B. Shell fallbacks / single binary** (`sh`, PowerShell, or a compiled helper) | Yes, no new runtime | PowerShell and sh differ a lot; a compiled helper means a build per OS and a supply-chain review |
| **C. A Bolt-provided sandboxed runtime** (WASM or an embedded script engine) | No | Big engineering; but it removes the interpreter problem, and is the natural place to enforce the permission and confinement roadmap |

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

`bolt-apps check <app> [--json] [--os macos|linux|windows] [--update-golden]` runs when the app folder has a `check.json`. (Snippet, search and transform apps still go through Bolt's own engines, which are not published; `check` on them says so.)

**Run it only on code you have read.** `check` executes the app's script and interpreter on your machine. The empty environment, temp HOME and stub PATH make the result repeatable; they are not a sandbox. A script can still read your real home directory, call tools by absolute path and use the network. Paths named in `check.json` must stay inside the app folder (`kit vendor` refuses anything else).

**What it does, per case:**

1. Builds a temp directory with a **stub command** for each recorded output (`fixtures/<os>/<cmd>.out`, optional `<cmd>.rc`) and a temp HOME.
2. Runs the script in a **clean subprocess**: environment is only `PATH` (the stub directory) and `HOME`; the working directory is the temp HOME. A command with no stub is "not found", so the script must handle a missing tool.
3. For `--os X`, runs only the cases for OS X and starts the script with the Python platform set to X (done by the harness wrapper, never by the script), so the script's `os_name()` picks that OS's commands.
4. **Hung-command mode**: `"hang": ["df", "lsof"]` makes those stubs sleep. The case asserts the whole run stays under its time budget (default 18 s, under the 20 s bridge limit) and the output still validates and does not say all clear.
5. **Hostile-data fuzz**: `"hostile": true` replaces `@@HOSTILE@@` in the fixtures with a payload (bidi, zero-width, tag, line separator, bell, `{{x}}`). Every case already scans all output for such characters and for `{{`/`}}`.
6. **Golden snapshots**: the rows must equal `golden/<name>.json`. `--update-golden` writes it; review the diff.
7. **Schema validation** of every output, and the label (14), footer (3 minus manifest actions, `manifest_actions` in `check.json`) and numeric-tile rules.
8. Expectations per case: `text_present`, `text_absent`, `max_seconds`, `exit`.
9. **Kit guard**: the `bolt_app_kit` beside the script must match its lock (`kit_modified`), and match this toolkit's kit when the versions are equal (`kit_diverged`). An older pinned version is an error (`kit_outdated`) unless `check.json` sets `allow_outdated_kit` after the older kit was reviewed. The hash covers the `.py` and `.json` files. The lock is not signed, so this catches accidents and unreviewed edits, not an author who rewrites the lock and the version on purpose; the pack signature (future, section 6) is what binds the kit to a release.

**Built in v0.1:** all of the above, on macOS or Linux hosts, for Python scripts.

**Not built:**
- Running on a Windows host (the stubs are `sh` scripts).
- Real behaviour of another OS. `--os windows` from a Mac tests the app's own logic against recorded output; it is reported as "Fixture-tested only". Path handling, encodings, real tools and the real tree kill are not exercised.
- The real launcher: row mapping, nav, the footer, tile rendering. `check` approximates the launcher's rules from its source; it can be wrong when the launcher changes.
- Interpreters other than the one in `check.json`, minimum-version checks, shell or Node scripts.
- Property-based fuzzing beyond the fixed hostile payload; parallel case execution; the `pack` integration (below).
- A fixture recorder.

**Follow-up (founder, not done here):** the fleet has real Linux and Windows machines. The same fixtures can be replayed there live by running the app against the real tools and diffing the rows against the goldens, which turns "fixture-tested only" into "run on that system".

## 6. How an app gets the kit

`bolt-apps kit vendor <app>` copies the kit (`*.py` and the schema) into the app's `scripts/bolt_app_kit/` and writes `scripts/bolt_app_kit.lock.json`: `{ "name", "version", "sha256" }`, where the hash covers the path and content of every `.py` and `.json` file. Python puts the script's own directory on `sys.path`, so `import bolt_app_kit` just works with no install.

**The signature covers the kit** because the vendored files are ordinary files inside the pack. **Divergence guard:** `check` fails `kit_modified` if the vendored files differ from the lock (edited by hand), `kit_diverged` if the lock claims this toolkit's version but the files differ from it, and warns `kit_outdated` if the app is pinned to an older version.

`bolt-apps pack` does not accept script apps yet (`lint` refuses tier 3). Packing a script app, with all per-OS entrypoints in one pack, one signature covering them, and `platforms` recorded in the pack manifest, is future work and needs the runtime to accept it.

**Bundled apps in `bolt-native`.** The sample apps that ship inside the desktop bundle could consume the kit later the same way: a sync script copies the pinned kit into their `scripts/` and a guard test fails when the copy differs from its lock. Not part of this task; no `bolt-native` file is touched.

## 7. Versioning and upgrades

Semantic versions in `bolt_app_kit.__version__`. While the version is `0.x`, a minor bump may change an API; each change is listed in the release note. The row contract is versioned separately by its schema (`$id`); a new optional field is not breaking, a new required field is. To upgrade an app: run `bolt-apps kit vendor <app>`, run `check --update-golden`, review the golden diff, run `check`. The lock records what the app was tested with.

## 8. Other languages

The contract is language neutral: the JSON Schema and `kit/conformance/cases.json` (inputs and expected outputs for every formatter, text function, the tile rule and the validation cases). Any implementation passes the same fixtures.

| Kit | State |
|---|---|
| Python | Built (v0.1). Runs `cases.json` in `tests/test_conformance.py` |
| TypeScript/Node | Second. Same `cases.json` and schema; it must pass the same cases and the same `check` fixtures, so the two kits are tested identically |
| Shell | A tiny emitter (`bolt-apps emit`, or a documented printf pattern) for apps that only print a few rows; no formatters |

The JS validator inside `check` already runs the `validate` cases from `cases.json`, which shows the fixtures are portable.

## 9. Out of scope

Permissions enforcement and confinement (the runtime), the gallery and its index, a JavaScript kit, Windows hosting for `check`, signing script apps.
