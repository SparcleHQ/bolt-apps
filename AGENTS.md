# AGENTS.md: authoring a Bolt App

> **Apps built before this change:** remove the old app in Bolt (Settings, Desktop App, User Apps; the Remove button is on the app's row on 181, and newer builds also show it in the expanded panel; do not delete files by hand), run `./bolt-apps new <template> <id>`, copy your own `config.json` and `fixtures.json` over the new ones, re-run `./bolt-apps check`, then `./bolt-apps ship`.

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) that
create or change an app in this repository. Follow them exactly. Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md).

> **Building an app for yourself (a rich app, a script, a web API)? Read [kit/examples/QUICKSTART.md](kit/examples/QUICKSTART.md) only: decision tree, four commands, ten rules and the one rules table. [kit/examples/CAPABILITIES.md](kit/examples/CAPABILITIES.md) says what works. The sections below are the reference. Pick the shape first: a typed word that calls the API is `lookup` (rows, no drill, no Back); drill and Back are `views` (its first word is a view, not a query). One app cannot do both: [ENGINE.md](kit/examples/ENGINE.md#two-shapes-of-app-lookup-or-views). An app that only shows sample data is allowed: [recipe](kit/examples/ENGINE.md#an-app-that-only-shows-sample-data-offline-no-api).**

> **Status: the gallery of community apps is not open yet: app submissions open later.** Do not open a pull request that
> adds an app to `apps/` unless the person you work for is a Sparcle maintainer. If they are not, you may open a pull
> request for a fix to the toolkit, the kit, the examples or the docs, with every commit signed off (`git commit -s`).
> You may still build and check an app locally.

## 1. What you are making

One folder, `apps/<id>/`, that holds:

| File | Required | Schema |
|---|---|---|
| `bolt-app.json` | yes | [`schema/bolt-app.schema.json`](schema/bolt-app.schema.json) |
| `README.md` | recommended | free text, see section 6 |
| `snippets/<key>.json` | one content file at least, any mix | `{"key", "label", "content"}` |
| `search_engines/<id>.json` | | `{"id", "name", "urlTemplate"}` |
| `utilities/<id>.yaml` | | [`schema/user-app.schema.json`](schema/user-app.schema.json), `runtime: transform` only |

No other files and no other folders. The checker refuses anything else (`unknown_file`). The toolkit skips what the OS or git leaves in a folder (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `.git`, `.gitignore`, `.gitattributes`) and never packs it.

The signed file format these travel in is a Boltpack; its `bundle.json` is described by
[`schema/boltpack-manifest.schema.json`](schema/boltpack-manifest.schema.json). You do not
write `bundle.json` by hand.

## 2. Kinds, tiers, permissions

| Kind | Folder | Tier | Permissions it needs |
|---|---|---|---|
| Snippet | `snippets/` | 1 | `reads_clipboard` if it uses `{clipboard}`; `copies_to_clipboard` |
| Search engine | `search_engines/` | 1 | `opens_links:<host>` |
| User App, `runtime: transform` | `utilities/` | 2 | `reads_launcher_input`, `copies_to_clipboard` |

The app's `tier` is the highest tier of anything in it. `permissions` is exactly the
union the content needs. The checker recomputes both and fails a lower tier
(`tier_understated`), an undeclared permission (`permission_undeclared`) and warns on an
unused one (`permission_unused`).

**The gallery (this repository) takes tier 1 and 2 only.** Tier 3 is refused here
(`tier3_not_accepted`): `runtime: bridge` or `http_local` User Apps, a `detect` block, scripts,
anything that runs commands, reads files, calls the network (`runs_commands`, `files`,
`network`) or gives an AI agent tools (`agent_tools`). Do not create tier 3 content in this
repository. Tier 3 apps stay personal today (`pack --personal`); a Sparcle-reviewed route for them may follow, but none exists yet, so do not promise one.

**Hand every app over as a `.boltpack`. That is the main route.** A plain `.yaml` saved in the User Apps folder (Settings, Desktop App, User Apps, Open folder, Reload) is the secondary route, for the person's own simple apps. The pack is what Bolt shows a review card for, and it carries the scripts.

**An app for the user's own use may be tier 3.** If the person wants an app that runs a
program or a script for themselves, do not tell them it is impossible and do not hand them a
tar.gz. Build it outside `apps/` and run `bolt-apps lint <folder> --personal`, then
`bolt-apps pack <folder> --personal`. Rules Bolt enforces on such a pack: scripts are single
files directly in `scripts/`, each named `<app id>__<name>` (every installed app shares ONE scripts folder, and Bolt refuses a file another app already owns, `owned_by_other`; the kit is the single file `scripts/<app id>__bolt_app_kit.py`; pick a distinctive app id, because Bolt tells apps apart by id and two authors who both ship `weather` still collide), with letters,
digits, `.`, `_` and `-`; every `{{scripts_dir}}/<name>` in the app file must exist; `runtime`
is `transform`, `bridge` or `http_local`; action `kind` is `url`, `composer`, `utility` or
`run`. Write the app YAML in plain form: bare keys with the colon touching them, values on one line (quoted or plain, `\"` and `\\` the only escapes), block lists and maps indented with spaces, no anchors, aliases, tags, block scalars (`|` `>`), duplicate keys or tabs. The tools read only that form; anything else is reported as `yaml_unreadable_here` and its tier as unknown. The person installs it by dropping the `.boltpack` on the Bolt launcher or Bolt Apps
(never Admin settings, which accepts only Sparcle-signed bundles and answers "Bundle
rejected"). Bolt shows what the app can do and asks them to confirm; a device with the
approved-only company policy refuses it.

Valid permission strings: `reads_clipboard`, `reads_launcher_input`, `copies_to_clipboard`,
`opens_links:<host>`, `runs_commands`, `network`, `files`, `agent_tools`.

## 3. Field rules you will otherwise get wrong

- `id` (folder and listing): `^[a-z0-9][a-z0-9-]{0,63}$`, equal to the folder name.
- Snippet `key`: `^[a-z][a-z0-9_-]{0,23}$`; `content` up to 10,000 characters. Tokens:
  `{date}`, `{time}`, `{datetime}`, `{uuid}`, `{clipboard}`, `{input:Name}`,
  `{input:Name=default}`, `{select:Name=A,B}`. Filters after `|`: upper, lower, title,
  camel, pascal, snake, kebab, constant, slug, reverse, trim, sort, uniq, joinlines,
  splitcsv, clean, url, urld, base64, unbase64, jsonescape, jsonunescape, sql, duration,
  sha256, sha1, sha512.
- Search engine `id` (the prefix): `^[a-z][a-z0-9]{0,11}$`, not a built-in prefix, not
  `@ = / :`. `urlTemplate` starts with `https://` and has at most one `{q}`.
- User App: unknown fields are refused. Never use the connector fields `scopes`,
  `filters`, `auth_profile_ref`, `requires`, `cache_ttl_seconds`, `provisioning_mode`,
  `departments`, `roles`, `groups`. `transform.pipe` has 1 to 32 steps from the list in
  the schema. `recognize.patterns` at most 16, each regex at most 512 characters.
- `author.link` must be `https://`.
- Tests: at least one per content file. A `recognizer` test must list at least one
  `negative` sample. Outputs are compared exactly after trailing whitespace is trimmed.
  Do not assert on `{uuid}` or the clock (use `now` for snippet tests).

## 4. Required tests and samples

Every content file needs a test in `bolt-app.json`:

| Kind | Test |
|---|---|
| snippet | `{"kind":"snippet","target":"<key>","clipboard":"...","fields":{...},"expect":"..."}` |
| search engine | `{"kind":"search","target":"<prefix>","query":"...","expect":"https://..."}` |
| transform | `{"kind":"transform","target":"<app id>","input":"...","expect":"..."}` |
| recognizer | `{"kind":"recognizer","target":"<app id>","positive":[...],"negative":[...],"expect_rep":[...]}` |

Sample data must be made up: `@example.com` emails, `ACME-123` style IDs, no real names,
no real customer or company data.

## 4a. Start from the toolkit

`bolt-apps` below means `./bolt-apps`, the launcher at the root of the clone (a short script that runs `toolkit/bin/bolt-apps.mjs` with Node; put the folder on PATH to type just `bolt-apps`). It needs Node 18+ and Python 3.9+.

```
./bolt-apps new <id> --type snippet|search|transform|recognizer
./bolt-apps lint apps/<id> --json     # exit 0 before you go on
./bolt-apps pack apps/<id>            # needs a key: bolt-apps keygen, once
./bolt-apps pack <folder> --personal   # own-use tier 3 or script app (section 2); never for the gallery
```

`lint` is the offline shape check; it does not run tests. Never put a signing key (`*.pem`) in this repository.

## 4b. Build loop for an app you keep for yourself (script apps, tier 3)

Do these in order. Each step prints findings with a stable `code`, the file, the line and the
fix; branch on `code` with `--json`, never on message text.

```
./bolt-apps lint <folder> --personal --json    # layout, ids, tier (exit 0 first)
./bolt-apps check <folder> --json              # script apps with check.json: runs the script against fixtures
./bolt-apps verify <folder> --json             # the rules Bolt enforces at install, before you pack
./bolt-apps keygen                             # once
./bolt-apps pack <folder> --personal           # <id>.boltpack, prints what the app can do
./bolt-apps verify <id>.boltpack --json        # the same rules on the file you will hand over
```

Then drop the `.boltpack` on the Bolt launcher or Bolt Apps (never Admin settings, Utilities,
Bundles: it takes only Sparcle-signed bundles and answers "Bundle rejected"). Bolt shows what
the app can do and asks the person to confirm.

`check` runs the script on this machine: run it only on code you have read.

Rules a script app must follow, each one a `verify` code:

- One app file per `utilities/<id>.yaml`; script names are plain
  (`script_name`); every file under `scripts/` starts with `<app id>__` (`script_not_namespaced`: Bolt installs all apps' scripts into one folder, so a bare `config.json` or `bolt_app_kit.py` stops a second app installing). The kit ships as one file, `scripts/<app id>__bolt_app_kit.py`, made by
  `bolt-apps kit vendor --flat <folder>`, which keeps the command's helper list short.
- The app file's `chip` must equal its `id` (`chip_not_id`): the launcher looks apps up by id, so another chip is offered but never runs.
- With no key an engine app starts in the state `api.on_missing_key` names: `sample` (labelled sample data, for a fictional-API demo) or `setup` (one row saying how to add the key, the default). After a drop the person sees the review card (it says the pack is self-signed: expected, install it), then Bolt's own "Install an unverified Bolt pack?" dialog (click Install), then Settings, Desktop App, User Apps, expand the app, Review and accept; again after every reship; an empty list on Enter means not approved yet. Details: `kit/examples/QUICKSTART.md`.
- The command names the script as `{{scripts_dir}}/<name>`, bare, never in quotes
  (`command_variable_in_quotes`, `script_path_relative`, `script_missing`). Example:
  `macos: "python3 {{scripts_dir}}/eagle-info__eagle.py {{view}}"`.
- The command is one program with arguments: no `;` `&&` `||` `|` backtick or `$(`
  (`command_shell_operator`). Put multi-step logic in the script.
- `bridge.parse` is `json`, `lines` or `raw`; `timeout_seconds` is 1 to 60; `emits` is one of
  the kinds in the schema (use `Generic`); no connector keys (`yaml_admin_only_key`,
  `yaml_key_unknown`).
- Give a command for each OS you support under `bridge.command` (`macos`, `linux`, `windows`);
  Bolt needs at least one (`command_missing`).

If Bolt does not show the app after the drop, open Settings, Desktop App, User Apps. Files
that failed to load are listed there with the file name and Bolt's error. Run
`verify <the folder or the pack> --json`: each Bolt error text below maps to one code.

| Bolt's error contains | verify code |
|---|---|
| `inside double quotes` or `inside single quotes` | `command_variable_in_quotes` |
| `malformed variable placeholder` or `unterminated` | `command_placeholder_malformed` |
| `forbidden shell metachar` | `command_shell_operator` |
| `not argv-splittable` | `command_not_argv` |
| `unknown field` | `yaml_key_unknown` |
| `admin-only field` | `yaml_admin_only_key` |
| `missing field` | `yaml_key_missing` |
| `runtime must be one of` | `runtime_not_allowed` |
| `requires a \`bridge\` block` | `block_missing` |
| `bridge.command must define` | `command_missing` |
| `timeout_seconds must be 1..=60` | `timeout_out_of_range` |
| `bridge.parse` | `parse_not_allowed` |

## 4c. A rich app for a web API: start from the portal template

If the person wants an app for a web API with a summary, tiles, lists they can drill into, a
detail panel and a cache, do not write the YAML or the script. Run
`bolt-apps new portal-template <id>` (it copies
[`kit/examples/portal-template`](kit/examples/portal-template) to a folder named after the new
app's id and renames every file and every mention of the template), change data in `scripts/<id>__config.json` and `scripts/<id>__fixtures.json`, generate the YAML and
ship it as a personal pack (section 4b). It is tier 3, so it never goes in `apps/`. The personal
pack is the way to ship a rich app: the gallery refuses it, and Bolt shows its permissions and asks
the person to confirm when they drop the pack on the Bolt launcher or Bolt Apps.

```
./bolt-apps new portal-template my-app --dir ~/my-apps   # copy, rename, sample passes
# edit ~/my-apps/my-app/scripts/my-app__config.json and fixtures.json (the `edit` list of the template in kit/examples/index.json)
# then regenerate the app file:  ./bolt-apps regen ~/my-apps/my-app   (an old app with its own engine copy: ./bolt-apps upgrade-kit ~/my-apps/my-app first)
./bolt-apps run ~/my-apps/my-app --sample     # the rows Bolt would show
./bolt-apps check ~/my-apps/my-app
./bolt-apps ship ~/my-apps/my-app              # lint --personal, check, pack (next version), verify
```

`ship` runs what sections 4b and 4c used to list by hand (lint, check, keygen once, pack with the next
version, verify). To do the steps yourself, `lint`, `verify`, `keygen` and `pack --personal --version X` still work.

Raise `--version` on every pack: Bolt refuses a pack that is the same version or older than the
installed one ("a pack is only replaced by a newer version"). Keep the pack outside the folder: a
`.boltpack` left inside the app folder gets in the way, so write packs elsewhere. Repack with the same
signing key you first used: a new keygen is a different signer, and Bolt may then refuse with "already belongs to" (from the 181 source, not seen live). The
install prompt rates a personal app HIGH RISK: any app that runs a program (tier 3) is, and the template's Open
button uses `{{row.open_url}}`, which adds "opens links that are not fixed https addresses". That is expected.

**Before you hand it over:** lint, check, verify and pack as above, then install the pack in Bolt
(drop it on the launcher or Bolt Apps, install at the review card, click Install on Bolt's own "Install an unverified Bolt pack?" dialog, then Settings, Desktop App, User Apps, expand the app, Review and accept; type `=<chip>`) and confirm the overview shows rows. The tools cannot draw the
launcher, so the first run in Bolt is the proof. Say which steps you could not do.

Every mention of `scripts_dir` in the app file, comments included, must be `{{scripts_dir}}/<file>`
as its own word, or Bolt says "Bolt cannot tell exactly which files this app runs" and never runs
it. The generated file already does this; never add a comment that names it. The launcher's rules
with the exact error text and the fix for each are in the "Rules Bolt enforces" table at
<https://sparcle.app/docs/extend/rich-apps/#rules>.

| Edit | Do not edit |
|---|---|
| `scripts/<id>__config.json`: endpoints and field `map`, `stats`, `overview`, `views` (labels, tile, up to 5 fields, body, link, `children`), `api`, `cache` | `scripts/<id>__engine.py` (the same file in every app built from the template) |
| `scripts/<id>__fixtures.json`: a sample response per endpoint, made-up data | `scripts/<id>__bolt_app_kit.py` and `bolt_app_kit.lock.json` (refresh only with `bolt-apps kit vendor --flat .`) |
| `bolt-app.json`, `README.md`, `check.json` (one case per view you add), `golden/` | `utilities/<id>.yaml` by hand: regenerate it with `./bolt-apps regen <app folder>` |

Pitfalls: stay inside the view limit in [the rules table](kit/examples/QUICKSTART.md#4-the-rules-table) (use `views[].children` for a detail level, it
reuses a view); no filter field in a row (the filter is the second word typed); scripts are flat
single files named `<id>__<name>`; the YAML stays in the plain form the engine writes; `id` equals the folder name,
`config.json` id and the yaml file name (lint refuses a mismatch); change `id` in `bolt-app.json` and delete the old
`utilities/<template>.yaml` after emitting the new one.
Row formats with the YAML that draws each: <https://sparcle.app/docs/extend/rich-apps/>. A full
example: [`kit/examples/acme-dash`](kit/examples/acme-dash).

## 5. Check

```
bolt-apps check apps/<id>          # human output
bolt-apps check apps/<id> --json   # branch on findings[].code, never on message text
```

`check` runs today for script apps (a `check.json` in the folder). For snippets, search
engines and transforms it is not published yet and says so; use `lint --json` and `verify`
until it is.

Exit `0` = pass. Exit `1` = fix every `error` finding and run it again. Exit `2` = the
command or the folder could not be loaded. Every code is listed in [CHECKER.md](CHECKER.md).
Do not stop at a passing exit code if a test you wrote is trivial; a test must fail when
the app is wrong.

## 6. README.md for the app

Plain words, under 200 words: what it does in one sentence, who it is for, what it saves,
one example (input and output), its permissions in words. No marketing, no em dashes.

## 7. Pull request conventions

- Branch: `app/<id>`. One app per pull request.
- Title: `app: <id> - <title>`.
- Body: fill in [the template](.github/PULL_REQUEST_TEMPLATE.md) completely and paste the
  full `bolt-apps check` output (or `lint` and `verify` output until `check` is published for tier 1 and 2 apps).
- Every commit signed off: `git commit -s`.
- Never edit `INDEX.json`, `RANKING.md`, `schema/`, `.github/` or another author's app.

## 8. Never include

- Secrets of any kind: API keys, tokens, passwords, private keys, signed URLs.
- Real personal data: names, emails, phone numbers, addresses, IDs of real people.
- Internal links: company intranet hosts, `localhost` URLs, private IP addresses.
- Tier 3 capabilities (section 2).
- Content that impersonates a company, product or person.

## 9. Worked example

Goal: a launcher key `=sortu` that sorts pasted lines and drops repeats.

`apps/sorted-unique-lines/utilities/sortu.yaml`:

```yaml
schema_version: 1
runtime: transform
id: sortu
chip: sortu
title: Sort and dedupe lines
icon: list
description: Sort pasted lines and drop repeats, on this device
emits: Generic
placeholder_examples:
  - "paste a list after =sortu"

presentation:
  widget: detail

transform:
  pipe:
    - lines
    - trim
    - dedupe
    - sort
```

`apps/sorted-unique-lines/bolt-app.json`:

```json
{
  "schema_version": 1,
  "id": "sorted-unique-lines",
  "title": "Sort and dedupe lines",
  "role": "Anyone who cleans up lists of names, hosts or IDs",
  "saves": "A minute each time you sort a list and remove repeats by hand",
  "summary": "Type =sortu, paste a list, copy it back sorted with no repeats.",
  "author": { "name": "Example Author", "link": "https://github.com/example-author" },
  "tier": 2,
  "permissions": ["reads_launcher_input", "copies_to_clipboard"],
  "tests": [
    {
      "kind": "transform",
      "name": "sorts and removes repeats",
      "target": "sortu",
      "input": "pear\napple\npear\nkiwi",
      "expect": "apple\nkiwi\npear"
    },
    {
      "kind": "transform",
      "name": "trims stray spaces before comparing",
      "target": "sortu",
      "input": "  b\na\nb  ",
      "expect": "a\nb"
    }
  ]
}
```

Check output (this example was run through the checker on 2026-10-20):

```
PASS  sorted-unique-lines  (tier 2)  apps/sorted-unique-lines
  ok   test: sorts and removes repeats
  ok   test: trims stray spaces before comparing

1 passed, 0 failed, 0 refused
```

Leaving out `reads_launcher_input`, or expecting the wrong output, gives
`permission_undeclared` and `test_failed`.

## 10. More

- Everything Bolt can load, beyond this gallery: <https://sparcle.app/docs/extend/>
- The Boltpack format: <https://sparcle.app/docs/extend/boltpack/>
- Security model: <https://sparcle.app/docs/extend/security/>
