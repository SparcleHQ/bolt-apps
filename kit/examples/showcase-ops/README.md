# showcase-ops

## What this teaches
A realistic observability dashboard drawn with the tile visuals of Bolt 0.1.184, on invented data that never leaves your computer. Type `=showcase-ops`:

| Row | What you see | Keys it uses |
|---|---|---|
| SLO, last 30 days | the plain meter, the way tiles look today | `max` |
| p99 latency | a sparkline with a dashed limit line | `trend`, `limit` |
| Error budget by service (Enter) | one ring per service | `visual: ring`, `max` |
| CPU against limit by service (Enter) | one bullet per service, with a target mark | `visual: bullet`, `max`, `target` |
| Services (Enter) | a list, worst state first; Enter on a service lists its own alerts, the app emits a Back row, and Bolt returns to the row you came from (not verified in real Bolt) | `children` |
| Alerts (Enter) | a plain list, critical first | none |

Severity is written in words (CRITICAL, WARNING, INFO, HEALTHY) and uses the badge words the engine already has: no new colours.

## Needs Bolt 0.1.184 or newer
`visual`, `target` and `limit` are new in 0.1.184. `bolt-app.json` says `min_bolt_version` `0.1.184` and lint refuses the keys without it. An older Bolt refuses the whole pack, so give it only to people on 0.1.184 or newer. In a personal version 1 app file the contract says an older Bolt warns and shows plain tiles; that is the contract, not something observed.

## One visual per pane
`visual` is a fixed word, not a field a row can fill in, so one tiles pane draws one visual. That is why the ring and the bullet each have their own view. Mixing visuals in one strip needs a later Bolt feature.

## Copy this to build
Any status dashboard: services, queues, jobs. Replace the three endpoints in `scripts/showcase-ops__config.json`, keep the views.

## Edit only these fields
`scripts/showcase-ops__config.json` (endpoints, stats, overview rows, views) and `scripts/showcase-ops__fixtures.json` (the invented answers). Then `./bolt-apps regen kit/examples/showcase-ops` and run check. Every option is in `../ENGINE.md`. The app holds no code of its own: it uses the shared engine and kit.

## Sample data
Eight invented services and seven invented alerts. The host `ops.example.invalid` cannot resolve, and the app starts in sample mode, so nothing connects anywhere. It reads no key, no file and no clipboard.

## Not verified
Not run in a real Bolt, and the drawn pixels (ring, bullet, target mark, dashed limit) have not been seen. It needs the native checker and the pane drawing for tile visuals that ship in Bolt 0.1.184; check the Bolt release notes.

## Commands
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.
```
./bolt-apps lint kit/examples/showcase-ops --personal
./bolt-apps check kit/examples/showcase-ops
./bolt-apps pack kit/examples/showcase-ops --personal --version 1.0.1 --out ../showcase-ops-1.0.1.boltpack
./bolt-apps verify ../showcase-ops-1.0.1.boltpack
```

Drop the `.boltpack` on the Bolt launcher or Bolt Apps (never Admin settings), install at the review card, click Install on Bolt's own dialog, then Settings, Desktop App, User Apps, expand the app, Review and accept, and type `=showcase-ops`. Raise `--version` on every pack.
