# Bolt Apps authoring kit

Write the data and the wiring; the kit does the formatting, the row structure and the JSON.

- `python/bolt_app_kit/`: the Python library (standard library only, 3.9+).
- `schema/row.schema.json`: the language-neutral row contract. `schema/gen-icons.mjs` generates the icon list from the launcher source.
- `conformance/cases.json`: inputs and expected outputs any implementation must pass.
- `examples/system-glance/`: a small app built with the kit, with fixtures and goldens for `bolt-apps check`.

Design and limits: [docs/kit-design.md](../docs/kit-design.md). Tool: [toolkit/README.md](../toolkit/README.md).

Script apps are tier 3, which the gallery does not accept, so the example lives here and not under `apps/`.
