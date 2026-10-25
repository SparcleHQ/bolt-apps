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
| `check` | Not published yet. It runs the tests through Bolt's own engines; Bolt runs the same tests when you add the app. |

## What this toolkit does not do

- It does not run your tests. `lint` checks their shape; Bolt runs them.
- It packs tier 1 and tier 2 content only (snippets, search engines, `runtime: transform` User Apps). Scripts and tier 3 apps are refused.
- It does not install. Install is Bolt's job, on purpose: Bolt re-verifies every pack itself and never trusts this tool.

## Format

A `.boltpack` is a gzip tar of `bundle.json`, `signature.bin` (Ed25519 over the exact bytes of `bundle.json`) and `manifests/`. The layout, hash and trust rules are on [sparcle.app/docs/extend/boltpack](https://sparcle.app/docs/extend/boltpack/) and in [`schema/boltpack-manifest.schema.json`](../schema/boltpack-manifest.schema.json).

## Tests

```
node --test toolkit/test/
```

Round trip for every template, tamper refusal, tier and permission rules, key handling.

## For AI agents

Run `new`, edit the files, run `lint --json` until it exits 0, then `pack`. Follow [AGENTS.md](../AGENTS.md).
