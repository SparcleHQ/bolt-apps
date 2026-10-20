# Unique errors from a log

Type `=errors` in the Bolt launcher and paste a log. You get each distinct error line once, with timestamps removed.

- **Who it is for:** developers and support staff reading long logs.
- **What it saves:** scrolling hundreds of lines to find which errors happened, and how many kinds.
- **Kind:** launcher app, pure transform (tier 2, acts inside Bolt).
- **Permissions:** reads what you type or paste into the launcher; copies its result to your clipboard. No commands, no network, no files.

## Sample

Input:

```
2026-10-20T09:00:01Z INFO server started
2026-10-20T09:00:02Z ERROR db timeout after 5s
2026-10-20T09:00:03Z WARN slow request
2026-10-20T09:00:04Z ERROR db timeout after 5s
2026-10-20T09:00:05Z FATAL out of memory
```

Result:

```
ERROR db timeout after 5s
FATAL out of memory
```

## How it works

`utilities/errors.yaml` is a Bolt User App with `runtime: transform`. Its pipe runs five of Bolt's built-in steps: split into lines, keep lines matching `ERROR`, `FATAL` or `CRITICAL`, strip a leading timestamp, split again, drop repeats.

Make it yours: change the `filter` pattern to `WARN|ERROR`, or add `sort`.

## Tests

Two checks: a mixed log, and a log with no errors (gives nothing).
