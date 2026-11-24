# lookup-template

## What this teaches
One typed word in, a stitched result out. Two chained keyless calls (Open-Meteo geocoding, then the forecast for the first match), laid out as a list with a preview pane: tiles with a 24 hour sparkline on the number rows, plain text on Coordinates and the forecast link (an entity_preview draws a tile only for a number, so a text-only row has no empty tile). This is the lookup archetype: `mode: lookup` with `steps`.

## Live terms, checked 2026-11-15 with real requests
- Geocoding `geocoding-api.open-meteo.com/v1/search` and forecast `api.open-meteo.com/v1/forecast`: no key, HTTPS, JSON. The forecast answers with `X-RateLimit-Limit: 600` per 60 seconds. Free for non-commercial use; credit Open-Meteo (CC BY 4.0). A `User-Agent` is sent (`api.user_agent`).
- The app caches each call (`cache.ttl` 900 s) and falls back to an old copy up to a day when the API fails.

## What a personal app cannot do here (built-in `=weather` can)
The themed sky card, the C/F toggle and the icon-only action bar. The `weather` pane kind does not show app data (Bolt says so), so this app uses tiles instead. Typing more than three words is cut off (three query words are passed).

## Copy this to build
Any "type a name, see a card" lookup over one or two APIs.

## Edit only these fields
`scripts/lookup-template__config.json`: `endpoints` (a path may use `{query}` and `{earlier_step.field}`), `lookup.steps`, `lookup.rows` (templates over the results, dotted paths and list indexes allowed, `trend_path` for a sparkline), `maps` (value labels such as weather codes). `scripts/lookup-template__fixtures.json`: the two recorded responses (real, trimmed). Details: `../ENGINE.md`.

## Commands
Run `./bolt-apps keygen` once before the first pack: it makes your signing key and never overwrites one.
```
./bolt-apps kit vendor --flat kit/examples/lookup-template
./bolt-apps regen kit/examples/lookup-template
./bolt-apps check kit/examples/lookup-template --update-golden
./bolt-apps lint kit/examples/lookup-template --personal
./bolt-apps pack kit/examples/lookup-template --personal --version 1.0.1 --out lookup-template-1.0.1.boltpack
```
Live is the default. `check` runs sample mode through `"fixture": true` in `check.json`.

Credit: Weather data by Open-Meteo.com (CC BY 4.0). Open-Meteo's free API is for non-commercial use (see https://open-meteo.com/en/terms); this example is a demo: for commercial use get an Open-Meteo commercial plan and API key.
