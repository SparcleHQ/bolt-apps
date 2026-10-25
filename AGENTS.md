# AGENTS.md: authoring a Bolt App

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) that
create or change an app in this repository. Follow them exactly. Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md).

> **Status: the gallery is not open yet and contributions are not accepted.** Do not open a pull request against this
> repository unless the person you work for is a Sparcle maintainer. You may still build
> and check an app locally.

## 1. What you are making

One folder, `apps/<id>/`, that holds:

| File | Required | Schema |
|---|---|---|
| `bolt-app.json` | yes | [`schema/bolt-app.schema.json`](schema/bolt-app.schema.json) |
| `README.md` | recommended | free text, see section 6 |
| `snippets/<key>.json` | one content file at least, any mix | `{"key", "label", "content"}` |
| `search_engines/<id>.json` | | `{"id", "name", "urlTemplate"}` |
| `utilities/<id>.yaml` | | [`schema/user-app.schema.json`](schema/user-app.schema.json), `runtime: transform` only |

No other files and no other folders. The checker refuses anything else (`unknown_file`).

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

**Tier 3 is refused here** (`tier3_not_accepted`): `runtime: bridge` or `http_local`
User Apps, scripts, anything that runs commands, reads files, calls the network
(`runs_commands`, `files`, `network`) or gives an AI agent tools (`agent_tools`). Do not
create tier 3 content in this repository.

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

```
node toolkit/bin/bolt-apps.mjs new <id> --type snippet|search|transform|recognizer
node toolkit/bin/bolt-apps.mjs lint apps/<id> --json     # exit 0 before you go on
node toolkit/bin/bolt-apps.mjs pack apps/<id>            # needs a key: bolt-apps keygen, once
```

`lint` is the offline shape check; it does not run tests. Never put a signing key (`*.pem`) in this repository.

## 5. Check

```
bolt-apps check apps/<id>          # human output
bolt-apps check apps/<id> --json   # branch on findings[].code, never on message text
```

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
  full `bolt-apps check` output.
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
icon: list-ordered
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
