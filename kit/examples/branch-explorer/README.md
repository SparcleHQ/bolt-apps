# Branch explorer
**What this shows:** a tree walked one level at a time: a view whose `children` point at itself, so every Enter goes in and Back comes out
**Edit these files:** `scripts/branch-explorer__config.json` (`views[0].children` and the root `arg` on the overview row) and `scripts/branch-explorer__fixtures.json` (`nodes` with an `id` and a `parent`).
**Run these commands** from the repo root (once before the first pack: `./bolt-apps keygen`; a higher `--version` each pack):
```
./bolt-apps lint kit/examples/branch-explorer --personal
./bolt-apps check kit/examples/branch-explorer
./bolt-apps pack kit/examples/branch-explorer --personal --version 1.0.1 --out ../branch-explorer-1.0.1.boltpack
./bolt-apps verify ../branch-explorer-1.0.1.boltpack
```

## Notes
Each row of `nodes` names its parent in `parent`. Enter on a row whose `children` exist opens that row; a row with no children is a leaf and shows `no_children`.

Sample data is invented. The app calls `https://api.example.com`, which does not exist: point `api.base_url` and `endpoints[].path` at your own API, or keep using fixture mode in `check.json`. See `../ENGINE.md` for every option.

After editing `config.json`, rebuild the app file: `./bolt-apps regen <this app folder>`. Drop the `.boltpack` on the Bolt launcher or Bolt Apps; the key never goes in the pack (see ENGINE.md, "Where to store keys").
