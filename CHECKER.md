# The Bolt Apps checker

`bolt-apps check` loads an app into a clean setup and runs it through Bolt's own code: the snippet engine, the search-engine validator, the launcher's transform pipe and the launcher recognizer. It recomputes the tier and the permissions from the content and refuses what the community gallery does not accept.

The checker is part of Bolt's own code, because that is where those engines live. The in-app gallery runs the same check before it lets anyone add an app. The command-line checker is not published yet; it will be before the gallery opens.

Until it is published, `node toolkit/bin/bolt-apps.mjs lint <folder>` runs the offline shape checks (layout, ids, tier, permissions, tests present). It does not run the tests.

## Run it

Once the checker is published:

```
bolt-apps check <app-folder | apps-folder | file.boltpack> [--json]
bolt-apps index <apps-folder> --out <index.json>
```

Examples:

```
bolt-apps check .                        # every app under apps/
bolt-apps check apps/cve-lookup --json
bolt-apps check clean-list.boltpack
```


Exit codes: `0` every app passed, `1` at least one failed or was refused, `2` usage or load error.

## Machine-readable output (`--json`)

```json
{
  "ok": true,
  "passed": 5, "failed": 0, "refused": 0,
  "reports": [
    {
      "app": "cve-lookup",
      "source": "apps/cve-lookup",
      "verdict": "pass",
      "tier": { "declared": 2, "computed": 2 },
      "permissions": { "declared": [...], "required": [...], "undeclared": [], "unused": [] },
      "adds": [{ "kind": "user_utility", "id": "cve", "label": "CVE lookup", "where": "Launcher app, type =cve", "path": "utilities/cve.yaml" }],
      "findings": [{ "level": "error|warning", "code": "test_failed", "message": "...", "path": "..." }],
      "tests": [{ "name": "...", "kind": "recognizer", "target": "cve", "ok": true }]
    }
  ]
}
```

`verdict` is `pass`, `fail` (fix the findings) or `refused` (tier 3: not accepted from the community gallery). Every finding has a stable `code`; agents should branch on `code`, people read `message`.

## What an app folder holds

```
apps/<id>/
  bolt-app.json            listing + tests (required)
  README.md                what it does, who for, what it saves, permissions, sample
  snippets/<key>.json      {"key", "label", "content"}            tier 1
  search_engines/<id>.json {"id", "name", "urlTemplate"} (https)  tier 1
  utilities/<id>.yaml      Bolt User App, runtime: transform      tier 2
```

Anything else under those folders, or any other content folder, is refused (`unknown_file`). A `.boltpack` carries the same files under `manifests/` and the listing in `bundle.json` `listing`.

## bolt-app.json

| Field | Meaning |
|---|---|
| `schema_version` | `1` |
| `id` | lowercase letters, digits, dashes; the folder name |
| `title`, `role`, `saves` | card text: name, who it is for, what it saves |
| `summary` | optional one line for the card |
| `author` | `{ "name", "link" }`, link must be https |
| `tier` | your claim: 1, 2 or 3; must not be lower than the computed tier |
| `permissions` | exactly what the content needs (see below) |
| `tests` | at least one |

Permissions: `reads_clipboard`, `reads_launcher_input`, `copies_to_clipboard`, `opens_links:<host>`, `runs_commands`, `network`, `files`, `agent_tools`. The checker computes the required set; an undeclared one fails (`permission_undeclared`), an unneeded one warns (`permission_unused`).

Tests:

```json
{ "kind": "snippet",    "target": "<key>", "clipboard": "...", "fields": {"Label": "value"}, "now": "2026-10-20T09:00:00Z", "expect": "..." }
{ "kind": "search",     "target": "<prefix>", "query": "...", "expect": "https://..." }
{ "kind": "transform",  "target": "<app id>", "input": "...", "expect": "..." }
{ "kind": "recognizer", "target": "<app id>", "positive": ["..."], "negative": ["..."],
  "expect_rep": [{ "input": "...", "label": "...", "value": "..." }] }
```

Outputs are compared exactly after trailing whitespace is trimmed. A recognizer must list at least one negative sample so it cannot flood ordinary text.

## What it refuses

| Code | Why |
|---|---|
| `tier3_not_accepted` | runs commands, calls the network or uses agent tools; needs review by Sparcle or company approval |
| `tier_understated` | listing claims a lower tier than the content |
| `permission_undeclared` | content needs a permission the listing does not declare |
| `sensitive_secret`, `sensitive_email`, `sensitive_internal_url` | a key, token, email address or internal link is still in the content (`@example.com` addresses are fine) |
| `test_failed` | a declared test did not produce its expected output; the message says what it got |
| `snippet_invalid`, `search_engine_invalid`, `user_app_invalid` | Bolt's own validator refused the item |
| `listing_invalid`, `unknown_file`, `parse_error`, `load_error`, `signature_invalid` | the app is malformed |

## Limits today

- The CLI verifies a `.boltpack` signature with the author key embedded in the pack. Packs signed by a Sparcle or company key report `unsigned` here; the desktop app verifies those at install.
- User App YAML is checked for runtime, transform steps and recognizer behaviour. Full structural validation of User App YAML happens in the desktop app when it loads the file.
- Snippet tests cannot fake the clock beyond `now`, and `{uuid}` output is random, so do not assert on it.
