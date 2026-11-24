# Feed template

Copy this folder when your API gives you **a list of ids** (one request per id) or **a result keyed by date**. It runs on sample data until you set `api.fixture_default` to `false` in `scripts/feed-template__config.json`.

| What | Where in `scripts/feed-template__config.json` |
|---|---|
| A list of ids, then one request per id | `endpoints.news.hydrate` (`path` with `{id}`, `limit`) |
| A date range in a path | `endpoints.asteroids.path`: `{today-2d}` to `{today}` |
| An object of lists keyed by date, flattened into one list | `endpoints.asteroids.flatten: "date"` |
| The field that is a row's id | `views[asteroids].id_field` |
| Drill to the rows of the same day | `children[].parent_field` and `match` |
| A key sent as a query parameter | `api.auth_in: "query"`, `api.auth_param` |

Sources: the Hacker News API (no key) and NASA's NeoWs feed (a free key; `DEMO_KEY` works at a low rate). Set `NASA_API_KEY` in `~/.config/feed-template/.env` (mode 600) or the system keychain; see [the quick path](../QUICKSTART.md).

The app file is generated. After editing `scripts/feed-template__config.json`:

```
./bolt-apps regen <this app folder>
bolt-apps check .
```

Edit only `scripts/feed-template__config.json` and `scripts/feed-template__fixtures.json`. Run `./bolt-apps check` from the repo root on `kit/examples/feed-template` for the same check.
