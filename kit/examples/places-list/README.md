# Places list
**What this shows:** rows with an Open button that opens each place in OpenStreetMap, built from latitude and longitude. There is no map widget
**Edit these files:** `scripts/places-list__config.json` (`views[0].item.url` and `fields`) and `scripts/places-list__fixtures.json` (`places` with `lat` and `lon`).
**Run these commands** from the repo root (once before the first pack: `./bolt-apps keygen`; a higher `--version` each pack):
```
./bolt-apps lint kit/examples/places-list --personal
./bolt-apps check kit/examples/places-list
./bolt-apps pack kit/examples/places-list --personal --version 1.0.1 --out ../places-list-1.0.1.boltpack
./bolt-apps verify ../places-list-1.0.1.boltpack
```

## Notes
A personal app cannot draw a map: the launcher refuses the `map` pane kind for a personal app (see ENGINE.md). The link opens the system browser, https only. Swap the `url` template for any maps site.

Sample data is invented. The app calls `https://api.example.com`, which does not exist: point `api.base_url` and `endpoints[].path` at your own API, or keep using fixture mode in `check.json`. See `../ENGINE.md` for every option.

After editing `config.json`, rebuild the app file: `./bolt-apps regen <this app folder>`. Drop the `.boltpack` on the Bolt launcher or Bolt Apps; the key never goes in the pack (see ENGINE.md, "Where to store keys").
