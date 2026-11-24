# Pipeline board
**What this shows:** stages that drill into their runs, a detail pane with a meter per run, and a `detail` pane (Before, After, What changed) for what changed
**Edit these files:** `scripts/pipeline-board__config.json` (`views`, `children`, the changes `detail` fields) and `scripts/pipeline-board__fixtures.json` (`stages`, `runs`, `changes`).
**Run these commands** from the repo root (once before the first pack: `./bolt-apps keygen`; a higher `--version` each pack):
```
./bolt-apps lint kit/examples/pipeline-board --personal
./bolt-apps check kit/examples/pipeline-board
./bolt-apps pack kit/examples/pipeline-board --personal --version 1.0.1 --out ../pipeline-board-1.0.1.boltpack
./bolt-apps verify ../pipeline-board-1.0.1.boltpack
```

## Notes
The changes view uses a `detail` pane with three bound fields. It was a `diff` (Compare) pane that drew an empty A/B box when a row was selected in a real launcher, so it no longer is: use `diff` only for real multi-line text, and check it in a launcher first (unverified for rows in 181).

Sample data is invented. The app calls `https://api.example.com`, which does not exist: point `api.base_url` and `endpoints[].path` at your own API, or keep using fixture mode in `check.json`. See `../ENGINE.md` for every option.

After editing `config.json`, rebuild the app file: `./bolt-apps regen <this app folder>`. Drop the `.boltpack` on the Bolt launcher or Bolt Apps; the key never goes in the pack (see ENGINE.md, "Where to store keys").
