# Clean up a messy list

Copy a comma-separated list from anywhere, type `;cleanlist` in the Bolt launcher, and get one item per line, sorted, with repeats removed.

- **Who it is for:** anyone who tidies lists of emails, tags or IDs.
- **What it saves:** about two minutes every time you sort and dedupe a list by hand.
- **Kind:** snippet pipeline (tier 1, data only).
- **Permissions:** reads your clipboard when you run it; copies its result to your clipboard.

## Sample

Clipboard: `pear, apple, kiwi, apple, banana`

Result:

```
apple
banana
kiwi
pear
```

## How it works

`snippets/cleanlist.json` is a normal Bolt snippet. Its content is one token with a filter chain: `{clipboard|splitcsv|sort|uniq}`. Each filter is one of Bolt's built-in snippet filters, applied left to right.

Make it yours: swap `sort` for `reverse`, add `upper`, or put text around the token.

## Tests

`bolt-app.json` carries two checks the checker runs through Bolt's own snippet engine: a plain list, and one with stray spaces and a trailing comma.
