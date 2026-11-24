# JSON tree browser
**What this shows:** a list of JSON documents, each drawn as a collapsible JSON tree in the right pane (`json_tree`, fed by `item.data_field`)
**Edit these files:** `scripts/json-tree-browser__config.json` (`endpoints`, `views[0].item.data_field`) and `scripts/json-tree-browser__fixtures.json` (one `documents` response whose rows carry a `payload` object).
**Run these commands** from the repo root (once before the first pack: `./bolt-apps keygen`; a higher `--version` each pack):
```
./bolt-apps lint kit/examples/json-tree-browser --personal
./bolt-apps check kit/examples/json-tree-browser
./bolt-apps pack kit/examples/json-tree-browser --personal --version 1.0.1 --out ../json-tree-browser-1.0.1.boltpack
./bolt-apps verify ../json-tree-browser-1.0.1.boltpack
```

## Notes
Row fields that are objects or arrays show as tree nodes. A `payload` that is not an object is dropped (the pane needs an object), so wrap a bare list as `{"items": [...]}`.

Sample data is invented. The app calls `https://api.example.com`, which does not exist: point `api.base_url` and `endpoints[].path` at your own API, or keep using fixture mode in `check.json`. See `../ENGINE.md` for every option.

After editing `config.json`, rebuild the app file: `./bolt-apps regen <this app folder>`. Drop the `.boltpack` on the Bolt launcher or Bolt Apps; the key never goes in the pack (see ENGINE.md, "Where to store keys").
