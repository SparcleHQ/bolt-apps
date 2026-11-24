#!/usr/bin/env bash
# cold-agent.sh: a REAL cold-agent run. A fresh agent gets ONLY the public docs and a task, in an empty folder, and builds an app;
# then the public toolkit checks what it produced (lint, check, verify).
#
# This is a MANUAL target (make cold-agent). It is NOT run in CI: it needs a live agent (network, a model, cost) and its result varies
# from run to run. CI runs only the offline checking half on a canned good and a canned bad app (toolkit/test/cold-agent-checker.test.mjs).
#
# Required: COLD_AGENT_CMD, the command that runs one agent turn, reading the prompt on stdin and working in the current folder,
#           for example:  COLD_AGENT_CMD='claude -p --permission-mode acceptEdits --max-turns 40 --allowedTools Bash(./bolt-apps:*) Read Write Edit Glob'
#           (acceptEdits alone is not enough: the agent could not run ./bolt-apps. This was run once on 2026-11-24 with the command above and
#           the produced app passed lint --personal, check and verify.)
# Optional: COLD_AGENT_DOCS  a folder holding QUICKSTART.md and agent-guide.md (default: fetched from sparcle.app)
#           COLD_AGENT_TASK  the task text (default below)
#           COLD_AGENT_KEEP=1 keep the work folder
# The agent sees: the two docs and a copy of the toolkit CLI to run, with the kit folder that `new` and `check` need.
# The task tells it to use only ./docs; that is an instruction, not a sandbox.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
: "${COLD_AGENT_CMD:?set COLD_AGENT_CMD, e.g. COLD_AGENT_CMD='claude -p --permission-mode acceptEdits'}"
TASK="${COLD_AGENT_TASK:-Build a Bolt App named cold-demo that shows three KPI tiles and one bar chart from fixed sample data and never touches the network. Start from a template with ./bolt-apps new (list them with ./bolt-apps new --list) and write no script of your own. Use only the docs in ./docs for how. Run ./bolt-apps lint (add --personal for a script app), check and verify until they pass. Put the app in ./out/cold-demo.}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cold-agent.XXXXXX")"
[ -n "$WORK" ] && [ -d "$WORK" ] || { echo "no work folder" >&2; exit 2; }
if [ "${COLD_AGENT_KEEP:-}" != 1 ]; then trap 'rm -rf -- "${WORK:?}"' EXIT; fi
mkdir -p "$WORK/docs" "$WORK/out" "$WORK/.cli"

if [ -n "${COLD_AGENT_DOCS:-}" ]; then
  cp "$COLD_AGENT_DOCS/QUICKSTART.md" "$COLD_AGENT_DOCS/agent-guide.md" "$WORK/docs/"
else
  curl -fsSL https://sparcle.app/docs/extend/agent-guide.md -o "$WORK/docs/agent-guide.md"
  curl -fsSL https://sparcle.app/docs/extend/bolt-apps/QUICKSTART.md -o "$WORK/docs/QUICKSTART.md"
fi
cp -R "$REPO/toolkit" "$REPO/schema" "$REPO/kit" "$WORK/.cli/"
printf '#!/bin/sh\nexec node "%s/.cli/toolkit/bin/bolt-apps.mjs" "$@"\n' "$WORK" > "$WORK/bolt-apps"
chmod +x "$WORK/bolt-apps"

echo "cold-agent: work folder $WORK"
( cd "$WORK" && printf '%s\n' "$TASK" | $COLD_AGENT_CMD ) || echo "cold-agent: the agent command exited non-zero (checking what it produced anyway)" >&2
node "$REPO/scripts/cold-agent-check.mjs" "$WORK/out"
