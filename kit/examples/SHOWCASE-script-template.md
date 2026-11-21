# Showcase: record `my-tool` from the terminal into Bolt

Public text for a recording of the template app: the commands, what to type in Bolt, and what each step should show. The app searches the Art Institute of Chicago's public-domain artworks with no key and no account. Everything below is what the sample data and a live run are written to show; it was not seen in a running Bolt yet, so look at each step before you record it and tell us what differs.

## 1. In the terminal (from the repository root)
```
./bolt-apps new script-template my-tool
```
Expect: `created my-tool from script-template (id my-tool, chip =my-tool). check passes on the sample data`, then Next steps, the first saying what to change first (the API in the config file).
```
./bolt-apps run my-tool items --sample
```
Expect: a short list of landscape paintings, `Back` first, a SAMPLE DATA row, then nine artworks (Poussin, Vuillard, Ruisdael, Corot and others) each with an artist, a date and a century badge.
```
./bolt-apps check my-tool
```
Expect: every case `ok`, then `All cases ran with stubbed commands on this OS.`
```
./bolt-apps ship my-tool
```
Expect: `ok check`, `ok pack`, `ok verify`, `Shipped my-tool ...: <path>.boltpack`, and the line `Start mode: live. This app needs no key.` Warnings that the listing still says TODO are expected until you write one line each in `bolt-app.json` and the config description.

## 2. Drop it into Bolt
Drop the `.boltpack` on the Bolt launcher. Install it (the pack is self-signed: expected), then Settings, Desktop App, User Apps, expand the app, Review and accept.

## 3. What to type in Bolt, and what to see
| Step | Type or press | Expect |
|---|---|---|
| 1 | `=my-tool` | Four number tiles on the right: Public domain 60% with a meter and a CC0 badge; Peak period 375 artworks with a sparkline, a delta and a PEAK badge; Top department with a meter; Pictured 9 artworks. First run takes about a second. |
| 2 | arrow down, Enter on Public domain | A list of landscape paintings. Select one: a small picture, facts (artist, date, medium, origin, department, rights), a note with the attribution, a tile for its period, buttons Open source and Copy summary. |
| 3 | type `items monet`, Enter | The list for another word (any word works, two words too). A word with no match shows one `No match` row. |
| 4 | Enter on an artwork | The detail: a big picture on top (about 400 pixels wide, in proportion), then the title, the artist and date, a short facts list, the description, credit, size, the attribution and the buttons Open source and Copy summary; Back, and Record (JSON). In sample mode only the first artwork has a recorded big picture. |
| 5 | Enter on Record (JSON) | The record as an open tree. Esc returns. |
| 6 | `=my-tool pictures` | A grid of cards with the pictures, titles, artists and dates. |
| 7 | `=my-tool chart` | A bar chart of public-domain artworks per period. |
| 8 | `=my-tool table` | A table of departments sorted by artworks, with a total row. Click a header to re-sort. |
| 9 | Open source (footer button) on an artwork | Opens the artwork's page on artic.edu in your browser. |
| 10 | Copy summary (footer button) | Puts one short line (title, artist, date, link) in the message box. |
| 11 | turn off the network, `=my-tool` | An old copy of the last results, labelled OLD COPY on the first tile. With nothing cached: one Could not reach row and Try again. |

## 4. Things to know before you record
- The list pane carries no picture: the entity preview pane only has a 40 pixel avatar slot on its own row in 181, which looks like a mistake, so the picture lives in the detail view (a markdown pane). The app puts it in the row itself because a personal app pane never loads a web address.
- Grid views (tiles, pictures, chart, table) have no Back row: press Esc or Left to go back.
- Sample data (`--sample`, and `check`) is labelled SAMPLE on its first row or tile. A shipped app always runs live.
- The data is from the Art Institute of Chicago (artic.edu): metadata CC0, descriptions CC BY 4.0, images of public-domain works CC0. Say so in the video.
