# Bolt Apps toolkit

One small command, `bolt-apps`, for making a Bolt App on your own machine. No account, no network, no dependencies. Node 18 or newer. `bolt-apps` in the docs means `./bolt-apps`, the launcher at the root of the clone (it runs `toolkit/bin/bolt-apps.mjs` with Node). Building a rich app for yourself? Start at [kit/examples/QUICKSTART.md](../kit/examples/QUICKSTART.md).

```
./bolt-apps new my-app --type transform     # start from a working template
./bolt-apps lint apps/my-app                 # offline shape checks
./bolt-apps keygen                           # once: your signing key
./bolt-apps pack apps/my-app                 # my-app.boltpack, self-signed
./bolt-apps verify my-app.boltpack           # Bolt's install rules, offline
```

Then drop the `.boltpack` on the Bolt launcher or on Bolt Apps. Bolt shows the review card (it says the pack is self-signed: expected, install it), then Bolt's own "Install an unverified Bolt pack?" dialog (click Install). Then open Settings, Desktop App, User Apps, expand the app and click Review and accept. Do not use Admin settings, Utilities, Bundles: that door takes only bundles signed by Sparcle and answers "Bundle rejected" to everything else. Dropping a pack on the launcher installs User Apps and scripts; Bolt skips snippets and search engines in a pack.

## An app for your own use (tier 3, scripts)

The gallery takes tier 1 and 2 only. An app that runs programs or reaches the network (`runtime: bridge` or `http_local`, a `detect` block, a script in `scripts/`) can still be packed for yourself or people who trust you:

```
./bolt-apps lint apps/my-app --personal
./bolt-apps pack apps/my-app --personal
```

`pack --personal` recomputes what the app can do from its files and prints it in plain words, then Bolt shows the same facts and asks whoever installs it to confirm, because the pack is signed only by you. On a device whose company policy allows only approved apps, Bolt refuses it. Every file under `scripts/` must be named `<app id>__<name>` (`script_not_namespaced`): all installed apps share one scripts folder and Bolt refuses a file another app already owns. The approval hash covers only helper files the command names as `{{scripts_dir}}/<file>`, so vendor the kit as one file with `kit vendor --flat`. `check.json`, `fixtures/` and `golden/` stay on your machine and are not packed.

## Commands

| Command | What it does |
|---|---|
| `new <template> <id> [--dir d] [--author "Your name"] [--thin]` | Copies a working template from `kit/examples` (`new --list` shows them and what to edit), renames it, puts your name in `author` (pack copies it into the pack as the author's name, so it is in every copy of the pack you share; with no `--author` it is your login name, so pass `--author` to use another name), writes the app file and records goldens, so `check` passes before you change anything. |
| `new <id> --type snippet\|search\|transform\|recognizer` | Creates `apps/<id>/` with `bolt-app.json`, a README and one content file. Every template passes `lint` and carries a test you can edit. |
| `regen <app>` | Writes `utilities/<id>.yaml` from an engine app's config (the same as `python3 scripts/<id>__engine.py --emit-yaml > utilities/<id>.yaml`; an app made with `new --thin` has no engine copy and needs this command). On an error it prints the problem and writes nothing. |
| `run <app> [view [word]] [--sample\|--live] [--json]` | Runs the app as Bolt would and prints the rows. It executes the app's own command with your real HOME and PATH. |
| `ship <app>` | `lint --personal`, `check`, makes your key once, `pack` with the next version, `verify`; prints how to install. |
| `doctor [app]` | Checks node, python, your key, `~/.bolt-apps` and what would block an install. |
| `lint [path]` | Offline checks: file layout, id and key rules, the tier and permissions your content needs, and that every content file has a test. `--json` for tools and agents; branch on `code`, not `message`. |
| `keygen [--out file]` | Makes an Ed25519 signing key in `~/.bolt-apps/key.pem` (mode 600). Never overwrites a key. Keep it out of any git repo. |
| `verify <app-folder or file.boltpack> [--json]` | The checks Bolt runs at install, offline: each problem has a stable `code`, the file, the line and the fix; then an estimate of what Bolt will show (tier, permissions, files); Bolt checks again at install. Exit 1 on any error. |
| `pack <app> [--key f] [--out f] [--version v] [--notes t] [--personal]` | Runs `lint`, then builds a `.boltpack` in Bolt's format and signs it. `--personal` allows tier 3 and script apps for your own use (not for the gallery). |
| `check <app> [--json] [--os macos\|linux\|windows] [--case text] [--update-golden]` | For a **script app** (a folder with `check.json`): runs the script in a clean subprocess (empty environment, temp HOME, stub commands from recorded output), validates every output against the row contract, enforces the numeric-tile, footer and label rules, a hung-command time limit, hostile text and golden snapshots. For snippets, search engines and transforms it is not published yet: it runs the tests through Bolt's own engines, and Bolt runs the same tests when you add the app. See [docs/kit-design.md](../docs/kit-design.md). |
| `kit vendor [--flat] <app>` | Copies the pinned Python kit (`bolt_app_kit`) into the app. `--flat` writes it as one file, `scripts/<app id>__bolt_app_kit.py` (every file of an app is named for it: Bolt keeps all apps' scripts in one folder, so pick a distinctive app id), with the lock beside `check.json`, so the app can be packed with `--personal`; the plain form copies a package folder (check only, not packable). `check` fails if the copy is edited by hand. |

## The authoring kit

`kit/` holds `bolt_app_kit`, a Python library (standard library only, 3.9+) that does formatting, row structure, JSON output, text safety, deadlines and caching, so an app only holds data and wiring. The row contract is a JSON Schema in `kit/schema/`. Example: `kit/examples/system-glance`. Design, what `check` covers and what it does not: [docs/kit-design.md](../docs/kit-design.md).

```
./bolt-apps kit vendor kit/examples/system-glance
./bolt-apps kit vendor --flat kit/examples/acme-dash   # one file, packable
./bolt-apps check kit/examples/system-glance
./bolt-apps check kit/examples/system-glance --os linux
```

`check` for script apps is a first slice. Run it only on code you have read: it executes the script on your machine, and the empty environment is not a sandbox. It runs your script against recorded command output on this machine. It does not run the real launcher or the real tools of another OS; cases for other OSes are labelled "fixture-tested only".

## What this toolkit does not do

- It does not run your tests. `lint` checks their shape; Bolt runs them.
- Without `--personal` it packs tier 1 and tier 2 content only (snippets, search engines, `runtime: transform` User Apps), which is all the gallery accepts. With `--personal` it also packs tier 3 and script apps for your own use. A kit app packs once the kit is vendored flat (`kit vendor --flat`); a package-folder kit cannot be packed because Bolt installs scripts flat.
- It does not install. Install is Bolt's job, on purpose: Bolt re-verifies every pack itself and never trusts this tool.

## Format

A `.boltpack` is a gzip tar of `bundle.json`, `signature.bin` (Ed25519 over the exact bytes of `bundle.json`) and `manifests/`. The layout, hash and trust rules are on [sparcle.app/docs/extend/boltpack](https://sparcle.app/docs/extend/boltpack/) and in [`schema/boltpack-manifest.schema.json`](../schema/boltpack-manifest.schema.json).

## Tests

```
node --test toolkit/test/*.test.mjs
(cd kit/python && python3 -m unittest discover -s tests)
```

Node 22 and newer expand `*.test.mjs` themselves. On Node 18 or 20 in PowerShell or cmd, which pass the `*` through unexpanded, run `node --test toolkit/test/` instead.

Round trip for every template, tamper refusal, tier and permission rules, key handling; the kit: icon drift, the row contract, `check` (failing apps fail, the example passes) and the Python unit tests. On recent GitHub Actions runs the Node suite took about 7 to 10 minutes, because it runs the examples end to end and a hung-command case.

## For AI agents

Run `new`, edit the files, run `lint --json` until it exits 0, then `pack`. Follow [AGENTS.md](../AGENTS.md).

Apps built before script files were named for their app: remove the old app in Bolt (Settings, User Apps, Remove), run `./bolt-apps new <template> <id>`, then copy your own `config.json` and `fixtures.json` over the new ones and re-run `./bolt-apps check`.
