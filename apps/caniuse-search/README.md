# Can I use, from the launcher

Type `ciu` and a feature name in the Bolt launcher to open its browser support table on caniuse.com.

- **Who it is for:** web developers checking browser support.
- **What it saves:** opening the site and finding the search box, many times a week.
- **Kind:** site search prefix (tier 1, data only).
- **Permissions:** opens web links when you choose them (caniuse.com).

## Sample

Type `ciu css :has()` and press Enter. Bolt opens `https://caniuse.com/?search=css%20%3Ahas()`.

## How it works

`search_engines/ciu.json` is a Bolt custom search engine: a prefix, a name and an https URL template with one `{q}`. Bolt encodes your words into `{q}`. Templates must be https; Bolt refuses anything else.

## Tests

Two checks: a single word, and words with symbols that must be encoded.
