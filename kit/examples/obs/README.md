# obs

## What this shows
`=obs` is one view over the monitoring tools a team runs. Each source is read by a small adapter into the same model (services with a status, alerts with a severity and a start time). Services are joined across sources by name, so one row says what every tool thinks of `checkout`. It ships on two public demos (Prometheus and Coroot), so it shows real data on the first run.

1. `=obs`: five tiles. Sources answering, healthy services, firing alerts, cross-tool signals, and Check again. Each drills (Enter).
2. `=obs services [word]`: every service from every source, worst first. A word filters by name. `bad`, `crit`, `warn` and `ok` filter by status; `cross` keeps services where tools agree, started together, or disagree. Pane: status per source and what is firing. Buttons: Copy summary, Triage with AI (puts a ready prompt in the composer).
3. `=obs alerts`: firing alerts from every source, worst first.
4. `=obs sources`: a table of each source with its state, service count, firing count and answer time.

## Your own sources
List them in `~/.config/obs/sources.json`. The file names keys, it never holds them (the app refuses a file others can write):

    {
      "sources": [
        {"name": "prod-prom", "type": "prometheus", "url": "https://prom.example.com", "auth": {"kind": "bearer", "secret": "PROM_TOKEN"}},
        {"name": "coroot", "type": "coroot", "url": "https://coroot.example.com", "project": "abc123xy", "auth": {"kind": "header", "header": "X-API-Key", "secret": "COROOT_API_KEY"}},
        {"name": "aws-prod", "type": "aws-cloudwatch", "profile": "prod", "region": "us-east-1"}
      ],
      "aliases": {"pay-svc": "payments"}
    }

- **Keys** sit in the system keychain or in `~/.config/obs/.env` (`chmod 600`; a file others can read is ignored). When one is missing the app shows the exact one-line setup, never a value. The key goes only to its own source's host, in the header that source needs: `bearer`, `basic` (with a `user`), or a named `header`.
- **URLs** are https, or http to this computer (a port-forward). No redirects are followed.
- **`aws-cloudwatch`** runs `aws cloudwatch describe-alarms` through the aws CLI you already use, so there is no key in Bolt: it uses your own sign-in (`aws sso login`). The command is an argument list, with no shell.
- **`aliases`** join two spellings of one service when the names differ.
- **Sources supported now:** `prometheus`, `coroot`, `aws-cloudwatch`. Others are added as adapters in `scripts/obs__app.py` (`ADAPTERS`).

## Edit these files
- `scripts/obs__config.json`: the demo sources, timeouts, cache times, the join window (30 minutes) and which name suffixes are ignored.
- `scripts/obs__app.py`: `prom_read()`, `coroot_read()` and `aws_read()` are the adapters; `join()` is the correlation; `service_row()`, `alert_row()` and `overview_rows()` build the rows; `emit_yaml()` writes the app file.
- `scripts/obs__fixtures.json`: answers recorded from the two public demos on 2026-11-23, trimmed.
- `check.json`: the cases.

## Run these commands
```
./bolt-apps run kit/examples/obs --sample
./bolt-apps check kit/examples/obs
./bolt-apps ship kit/examples/obs   # writes the pack to ~/.bolt-apps
```
After editing `obs__config.json` or the pane layout, regenerate the app file: `python3 scripts/obs__app.py --emit-yaml > utilities/obs.yaml`. Unit tests for the join, the auth rules and the CLI lane: `python3 -m unittest tests.test_obs_example` from `kit/python`.

## What was not verified
- Installed and run in a real Bolt on macOS by a maintainer on 2026-11-22 (the Bolt build number was not recorded, so index.json says "not verified in real Bolt", the only wording its test allows). Windows is unproven.
- The join was tested on synthetic data. The two demos are unrelated systems with no shared service names, so the live demo shows 0 cross-tool signals.
- The `aws-cloudwatch` adapter was tested only against a stub `aws` that prints the documented JSON shape. It has not run against real AWS.
- Bearer, basic and header auth were tested as the headers built from a key. No keyed Prometheus or Coroot was read.
- Prometheus is read through `/api/v1/query?query=up` and `/api/v1/alerts`; Coroot through its UI API (not a versioned public API), as in the `coroot` example.

Data: Prometheus (Apache-2.0, https://github.com/prometheus/prometheus) via PromLabs' public demo; Coroot (Apache-2.0, https://github.com/coroot/coroot) via its public demo. See the provider's terms.
