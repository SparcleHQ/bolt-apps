# CSV to Markdown table

Type `=csv2md` in the Bolt launcher and paste CSV or cells copied from a spreadsheet. Copy a ready Markdown table.

- **Who it is for:** anyone pasting spreadsheet data into docs, tickets or chat.
- **What it saves:** hand-typing pipes and dashes to turn a spreadsheet into a table.
- **Kind:** paste parser, pure transform (tier 2, acts inside Bolt).
- **Permissions:** reads what you type or paste into the launcher; copies its result to your clipboard.

## Sample

Input:

```
name,team,open tickets
Asha,Platform,3
Li,Design,12
```

Result:

```
| name | team     | open tickets |
|------|----------|--------------|
| Asha | Platform | 3            |
| Li   | Design   | 12           |
```

## How it works

`utilities/csv2md.yaml` pipes the input through Bolt's `table` step (comma, tab or pipe separated) and its `markdown` renderer.

Know this: Bolt treats the first row as a header when it is all labels and some later row has a number. A table of words only renders with `col1`, `col2` headers.

## Tests

Two checks: comma separated, and tab separated as copied from a spreadsheet.
