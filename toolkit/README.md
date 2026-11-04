# Bolt Apps toolkit

One small command, `bolt-apps`, for making a Bolt App on your own machine. No account, no network, no dependencies. Node 18 or newer.

```
node toolkit/bin/bolt-apps.mjs new my-app --type transform     # start from a working template
node toolkit/bin/bolt-apps.mjs lint apps/my-app                 # offline shape checks
node toolkit/bin/bolt-apps.mjs keygen                           # once: your signing key
node toolkit/bin/bolt-apps.mjs pack apps/my-app                 # my-app.boltpack, self-signed
node toolkit/bin/bolt-apps.mjs verify my-app.boltpack           # Bolt's install rules, offline
```

Then drop the `.boltpack` on the Bolt launcher or on Bolt Apps. Bolt shows a review card and, because you signed it yourself, asks once more before it installs. Do not use Admin settings, Utilities, Bundles: that door takes only bundles signed by Sparcle and answers "Bundle rejected" to everything else. Dropping a pack on the launcher installs User Apps and scripts; Bolt skips snippets and search engines in a pack.

## An app for your own use (tier 3, scripts)

The gallery takes tier 1 and 2 only. An app that runs programs or reaches the network (`runtime: bridge` or `http_local`, a `detect` block, a script in `scripts/`) can still be packed for yourself or people who trust you:

```
node toolkit/bin/bolt-apps.mjs lint apps/my-app --personal
node toolkit/bin/bolt-apps.mjs pack apps/my-app --personal
```

`pack --personal` recomputes what the app can do from its files and prints it in plain words, then Bolt shows the same facts and asks whoever installs it to confirm, because the pack is signed only by you. On a device whose company policy allows only approved apps, Bolt refuses it. Scripts keep their folders (a vendored `bolt_app_kit` installs where you put it), with plain names and at most 8 folders deep. Bolt 0.1.179 and earlier refuse a script inside a folder when the pack is dropped; Bolt 0.1.180 and later install it. `check.json`, `fixtures/` and `golden/` stay on your machine and are not packed.

## Commands

| Command | What it does |
|---|---|
| `new <id> --type snippet\|search\|transform\|recognizer` | Creates `apps/<id>/` with `bolt-app.json`, a README and one content file. Every template passes `lint` and carries a test you can edit. |
| `lint [path]` | Offline checks: file layout, id and key rules, the tier and permissions your content needs, and that every content file has a test. `--json` for tools and agents; branch on `code`, not `message`. |
| `keygen [--out file]` | Makes an Ed25519 signing key in `~/.bolt-apps/key.pem` (mode 600). Never overwrites a key. Keep it out of any git repo. |
| `verify <app-folder or file.boltpack> [--json]` | The checks Bolt runs at install, offline: each problem has a stable `code`, the file, the line and the fix; then an estimate of what Bolt will show (tier, permissions, files); Bolt checks again at install. Exit 1 on any error. |
| `pack <app> [--key f] [--out f] [--version v] [--notes t] [--personal]` | Runs `lint`, then builds a `.boltpack` in Bolt's format and signs it. `--personal` allows tier 3 and script apps for your own use (not for the gallery). |
| `check <app> [--json] [--os macos\|linux\|windows] [--case text] [--update-golden]` | For a **script app** (a folder with `check.json`): runs the script in a clean subprocess (empty environment, temp HOME, stub commands from recorded output), validates every output against the row contract, enforces the numeric-tile, footer and label rules, a hung-command time limit, hostile text and golden snapshots. For snippets, search engines and transforms it is not published yet: it runs the tests through Bolt's own engines, and Bolt runs the same tests when you add the app. See [docs/kit-design.md](../docs/kit-design.md). |
| `kit vendor <app>` | Copies the pinned Python kit (`bolt_app_kit`) into the app's `scripts/` and writes a lock file (name, version, sha256). `check` fails if the copy is edited by hand. |

## The authoring kit

`kit/` holds `bolt_app_kit`, a Python library (standard library only, 3.9+) that does formatting, row structure, JSON output, text safety, deadlines and caching, so an app only holds data and wiring. The row contract is a JSON Schema in `kit/schema/`. Example: `kit/examples/system-glance`. Design, what `check` covers and what it does not: [docs/kit-design.md](../docs/kit-design.md).

```
node toolkit/bin/bolt-apps.mjs kit vendor kit/examples/system-glance
node toolkit/bin/bolt-apps.mjs check kit/examples/system-glance
node toolkit/bin/bolt-apps.mjs check kit/examples/system-glance --os linux
```

`check` for script apps is a first slice. Run it only on code you have read: it executes the script on your machine, and the empty environment is not a sandbox. It runs your script against recorded command output on this machine. It does not run the real launcher, Windows, or the real tools of another OS; those cases are labelled "fixture-tested only".

## What this toolkit does not do

- It does not run your tests. `lint` checks their shape; Bolt runs them.
- Without `--personal` it packs tier 1 and tier 2 content only (snippets, search engines, `runtime: transform` User Apps), which is all the gallery accepts. With `--personal` it also packs tier 3 and script apps for your own use. A kit app (a vendored `bolt_app_kit` folder under `scripts/`) still cannot be packed: Bolt installs scripts flat.
- It does not install. Install is Bolt's job, on purpose: Bolt re-verifies every pack itself and never trusts this tool.

## Format

A `.boltpack` is a gzip tar of `bundle.json`, `signature.bin` (Ed25519 over the exact bytes of `bundle.json`) and `manifests/`. The layout, hash and trust rules are on [sparcle.app/docs/extend/boltpack](https://sparcle.app/docs/extend/boltpack/) and in [`schema/boltpack-manifest.schema.json`](../schema/boltpack-manifest.schema.json).

## Tests

```
node --test toolkit/test/
(cd kit/python && python3 -m unittest discover -s tests)
```

Round trip for every template, tamper refusal, tier and permission rules, key handling; the kit: icon drift, the row contract, `check` (failing apps fail, the example passes) and the Python unit tests. The suite takes about a minute because it runs a hung-command case.

## For AI agents

Run `new`, edit the files, run `lint --json` until it exits 0, then `pack`. Follow [AGENTS.md](../AGENTS.md).
