# coroot

## What this shows
`=coroot` shows a Coroot instance (eBPF observability) from the launcher: service health, SLO incidents with the root cause Coroot found, and node load. A script app on the flat kit, with every value read from Coroot's own read-only HTTP API. It ships pointed at Coroot's public demo (`demo.coroot.com`, anonymous, read-only) so it shows real data on the first run.

1. `=coroot`: three tiles. Healthy services, open incidents, average node CPU. Each drills (Enter).
2. `=coroot apps [word]`: every service, unhealthy first. The row says WHY (the failing checks, for example `network: failed conns`). Pane: latency, errors, upstreams, instances. Buttons: Open in Coroot, Copy summary, Triage with AI (puts a ready prompt in the composer). A bare word, `=coroot front`, filters the list.
3. `=coroot incidents`: titled by Coroot's root-cause headline, with severity, duration, impact and the full summary in the pane.
4. `=coroot nodes`: a sortable table, with CPU, memory and zone, and a BUSY badge.

## Your own Coroot
Put these in `~/.config/coroot/.env` (`chmod 600`; the app refuses a file others can read):

```
COROOT_URL=https://coroot.example.com
COROOT_PROJECT=abc123xy
COROOT_API_KEY=...
```

`COROOT_URL` is https, or http to this computer (a port-forward). `COROOT_PROJECT` is optional: with none the app asks `/api/user` and takes the first project. The key goes only to that one host, in an `X-API-Key` header, and never into a row or an error. No redirects are followed.

## Edit these files
- `scripts/coroot__config.json`: the demo address, cache times, timeouts.
- `scripts/coroot__app.py`: `n_apps()`, `n_incidents()`, `n_nodes()` read Coroot's answers; `app_row()`, `incident_row()` and `overview_rows()` build the rows; `emit_yaml()` writes the app file.
- `scripts/coroot__fixtures.json`: answers recorded from the public demo on 2026-11-23 (Coroot 1.29.4), trimmed.
- `check.json`: the cases.

## Run these commands
```
./bolt-apps run kit/examples/coroot --sample
./bolt-apps check kit/examples/coroot
./bolt-apps ship kit/examples/coroot   # writes the pack to ~/.bolt-apps
```
After editing `coroot__config.json` or the pane layout, regenerate the app file: `python3 scripts/coroot__app.py --emit-yaml > utilities/coroot.yaml`.

## What was not verified
- Installed and run in a real Bolt on macOS (2026-11-22, Bolt 0.1.181 or newer). Windows is unproven.
- The Open in Coroot links (`/p/<project>/app/<id>`, `/p/<project>/incidents/<key>`) are written from Coroot's UI routes, not checked against a running UI.
- The `X-API-Key` header against a self-hosted or cloud Coroot is untested: only the anonymous demo was read.
- Only the endpoints `overview/applications`, `overview/nodes` and `incidents` are used. Coroot's API is the one its own UI uses and is not a documented, versioned API, so a Coroot upgrade can change an answer. A changed answer shows as an unread answer, never as zero.
- Coroot's own MCP server (`/mcp`, OAuth) is the better route for an AI agent. This app is the zero-token launcher view.

Data: Coroot (Apache-2.0, https://github.com/coroot/coroot). The demo is Coroot's hosted instance; see the provider's terms.
