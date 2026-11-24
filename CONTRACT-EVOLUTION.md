# How the Bolt Apps contract changes

The contract is what an app file, a pack and a script may say, and what Bolt does with it. It lives in `schema/bolt-rules.json`; `kit/examples/capabilities.json` lists each capability with the Bolt version that first reads it. This page is the promise about how that changes.

## Additive only

- Never remove, rename or change the meaning of a key, a kind or a value that a released Bolt reads.
- A new thing gets a new key or a new kind, with a since-version in `schema/bolt-rules.json` and a row in `capabilities.json`.
- A new value for an old key (a new chart type, a new format word) is a new thing too: it carries its own since-version (`since_values`).
- An app that passes `check` today keeps passing on every later Bolt. The gallery apps and their goldens are the proof: `toolkit/test/compat-corpus.test.mjs` runs `lint` and `check` on all of them on every change.

## Unknown keys, per Bolt version

- A Bolt reads the keys it knows. A key it does not know is named in the error.
- A new kind, or a new key inside a `schema_version` 2 pack, makes an older Bolt refuse the WHOLE pack. So set `min_bolt_version` to the oldest Bolt that has everything the app uses (lint demands it).
- A personal `schema_version` 1 file warns and ignores a key an older Bolt does not know.
- Pick the oldest version that has the feature. The Since column of `CAPABILITIES.md` says which.

## Deprecation

- A deprecated key keeps working, unchanged, for at least two releases after the release that deprecates it.
- From that release lint warns and says what to use instead.
- `./bolt-apps migrate <app-folder>` rewrites the deprecated keys (`--dry-run` shows the changes). The list lives in `toolkit/lib/migrate.mjs`. In 184 it is empty: nothing is deprecated.
- Removal is never silent: it needs a new `schema_version` and a migration that runs by itself when an old app is installed.

## Reserved extension points

These names are held so later work is additive. Each is `reserved` in `capabilities.json`, has no since-version, and lint refuses it today. A reserved row can never be listed as supported until it ships with a version.

- Data sources: a script (runtime `bridge`) is the only source today. HTTP, websocket or stream sources and a TypeScript bridge come later as new `runtime` values.
- Widget kinds: the built-in list in `schema/bolt-rules.json`, each with a since-version in `kind_since`. A new kind is a new entry; an old kind never changes.
- Renderer families: the declarative chart pane is the only chart. A richer renderer arrives as new bind keys or a new kind, never as drawing code in a script.

## What an older Bolt says

A Bolt before 0.1.184 that is given a pack using a 184 kind or key refuses it with the generic message "This pack could not be verified, so it was not installed". Nothing reads `min_bolt_version` at install: it is a promise the author makes and a lint check. There is no install-time version check in 184.

## Ahead of the kit

Bolt 0.1.184 also accepts a graph pane (a service map, up to 60 nodes and 200 links, above that it groups nodes by bind.group, or shows a table with a reason). This kit has no authoring rules or sample for it yet, so lint refuses it; they come with 184.1. `capabilities.json` lists it as `partial` with that gap named.

## When a change lands

1. The rule goes into `schema/bolt-rules.json` with its since-version, and into `schema/user-app.schema.json`.
2. A row goes into `capabilities.json` with `since`, `older_bolt` and a sample. `node scripts/build-capabilities.mjs` writes `CAPABILITIES.md`.
3. `toolkit/test/contract-evolution.test.mjs` fails if a row has no since-version or no sample, or if a reserved item is accepted by lint.
