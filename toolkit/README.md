# Bolt Apps toolkit

One small command, `bolt-apps`, for making a Bolt App on your own machine. No account, no network, no dependencies. Node 18 or newer.

```
node toolkit/bin/bolt-apps.mjs new my-app --type transform     # start from a working template
node toolkit/bin/bolt-apps.mjs lint apps/my-app                 # offline shape checks
node toolkit/bin/bolt-apps.mjs keygen                           # once: your signing key
node toolkit/bin/bolt-apps.mjs pack apps/my-app                 # my-app.boltpack, self-signed
node toolkit/bin/bolt-apps.mjs verify my-app.boltpack           # hash and signature
```

Then drop the `.boltpack` on the Bolt launcher. Bolt shows a review card and, because you signed it yourself, asks once more before it installs.

## Commands

| Command | What it does |
|---|---|
| `new <id> --type snippet\|search\|transform\|recognizer` | Creates `apps/<id>/` with `bolt-app.json`, a README and one content file. Every template passes `lint` and carries a test you can edit. |
| `lint [path]` | Offline checks: file layout, id and key rules, the tier and permissions your content needs, and that every content file has a test. `--json` for tools and agents; branch on `code`, not `message`. |
| `keygen [--out file]` | Makes an Ed25519 signing key in `~/.bolt-apps/key.pem` (mode 600). Never overwrites a key. Keep it out of any git repo. |
| `pack <app> [--key f] [--out f] [--version v] [--notes t]` | Runs `lint`, then builds a `.boltpack` in Bolt's format and signs it. |
| `verify <file>` | Checks the signature and every file hash. A valid result proves the files did not change after signing. It does not prove who signed. |
| `check <app> [--json] [--os macos\|linux\|windows] [--case text] [--update-golden]` | For a **script app** (a folder with `check.json`): runs the script in a clean subprocess (empty environment, temp HOME, stub commands from recorded output), validates every output against the row contract, enforces the numeric-tile, footer and label rules, a hung-command time limit, hostile text and golden snapshots. For snippets, search engines and transforms it is not published yet: it runs the tests through Bolt's own engines, and Bolt runs the same tests when you add the app. See [docs/kit-design.md](../docs/kit-design.md). |
| `kit vendor <app>` | Copies the pinned Python kit (`bolt_app_kit`) into the app's `scripts/` and writes a lock file (name, version, sha256). `check` fails if the copy is edited by hand. |

## The authoring kit

`kit/` holds `bolt_app_kit`, a Python library (standard library only, 3.9+) that does formatting, row structure, JSON output, text safety, deadlines and caching, so an app only holds data and wiring. The row contract is a JSON Schema in `kit/schema/`. Example: `kit/examples/system-glance`. Design, what `check` covers and what it does not: [docs/kit-design.md](../docs/kit-design.md).

```
node toolkit/bin/bolt-apps.mjs kit vendor kit/examples/system-glance
node toolkit/bin/bolt-apps.mjs check kit/examples/system-glance
node toolkit/bin/bolt-apps.mjs check kit/examples/system-glance --os linux
```

`check` for script apps is a first slice. It runs your script against recorded command output on this machine. It does not run the real launcher, Windows, or the real tools of another OS; those cases are labelled "fixture-tested only".

## What this toolkit does not do

- It does not run your tests. `lint` checks their shape; Bolt runs them.
- It packs tier 1 and tier 2 content only (snippets, search engines, `runtime: transform` User Apps). Scripts and tier 3 apps are refused, so a kit app cannot be packed yet and is not accepted by the gallery.
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
