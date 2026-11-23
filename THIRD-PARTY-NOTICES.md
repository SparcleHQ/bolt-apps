# Third-party notices

This repository contains no third-party source code. The toolkit has no dependencies and the
Python kit uses only the Python standard library.

Some example apps, when you run them in Bolt on your own device, ask free public web services
for data and show it to you. Those services, their data and their words are not ours and are
not covered by the Apache License. Each belongs to its provider and is used under the
provider's own terms, linked below. Nothing here is legal advice. Each row was checked
against the provider's own page on 2026-11-17; where a page did not state a licence, this
file says so instead of guessing.

The toolkit does not fetch or store any of this data. An example's script may cache answers
for a while under `~/.bolt-apps/cache/<app id>/` on your computer (see [PRIVACY.md](PRIVACY.md)).
The fixture files in the examples are invented sample data and are ours, under the Apache
License.

## Services the examples contact

| Service and host | Used by | What the provider says | Credit to show | Terms |
|---|---|---|---|---|
| OpenStreetMap data through Nominatim (`nominatim.openstreetmap.org`) and Overpass (`overpass-api.de`); links to `www.openstreetmap.org` | around (data); places-list, sky-watch, lookup-template (map links only) | Data is open under the Open Database Licence (ODbL) by the OpenStreetMap Foundation; credit OpenStreetMap and its contributors and make clear the data is under the ODbL. Nominatim: at most 1 request a second, a User-Agent that names the app, show attribution. Overpass public server: under about 10,000 queries and 1 GB a day. | Map data (c) OpenStreetMap contributors, ODbL | <https://www.openstreetmap.org/copyright>, <https://operations.osmfoundation.org/policies/nominatim/>, <https://wiki.openstreetmap.org/wiki/Overpass_API> |
| Open-Meteo (`api.open-meteo.com`, `geocoding-api.open-meteo.com`) | around, sky-watch, lookup-template | The free API is for non-commercial use only ("You may only use the free API services for non-commercial purposes"), under 10,000 calls a day, and you accept the CC BY 4.0 licence. These examples are demos: for commercial use get an Open-Meteo commercial plan and API key. | Weather data by Open-Meteo.com (CC BY 4.0) | <https://open-meteo.com/en/terms>, <https://open-meteo.com/en/licence> |
| Wikipedia (`en.wikipedia.org`) | around | Text is licensed by its contributors under CC BY-SA 4.0 (and GFDL); reuse needs credit and the same licence. | Landmarks from Wikipedia (CC BY-SA) | <https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use> (section 7) |
| CityBikes (`api.citybik.es`) | around | A free service. Its one condition: an app that uses the API should say so and link the project page. It says its data is "not exactly open data". No licence is stated. | Bikes by CityBikes, linking <https://citybik.es/> (the around example now shows the link) | <https://api.citybik.es/v2/> (section "Terms of Service") |
| USGS earthquake feed (`earthquake.usgs.gov`) | sky-watch | USGS says most of its website content is in the U.S. public domain, but not everything on its sites; non-USGS material may be copyrighted. It does not say which terms apply to this feed specifically. | Earthquake data from the U.S. Geological Survey | <https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits> |
| Launch Library 2 (`ll.thespacedevs.com`) | sky-watch | Free for up to 15 unauthenticated requests an hour. No data licence found on the page we read. | Launch data from The Space Devs (Launch Library 2) | <https://thespacedevs.com/llapi> |
| Where the ISS at? (`api.wheretheiss.at`) | sky-watch | No authentication, limited to roughly 1 request a second. No data licence found on the page we read. | ISS position from wheretheiss.at | <https://wheretheiss.at/w/developer> |
| Hacker News API (`hacker-news.firebaseio.com`) | pulse-feed, feed-template | Public data in near real time; the API page states no rate limit and no data licence. Stories and comments are posts by their authors. | Hacker News | <https://github.com/HackerNews/API>, <https://www.ycombinator.com/legal/> |
| Hacker News search by Algolia (`hn.algolia.com`) | pulse-feed, repo-radar | We could not read a licence statement on the provider's page. See the provider's terms. | Hacker News search by Algolia | <https://hn.algolia.com/api> |
| GitHub REST API (`api.github.com`) | repo-radar | GitHub's API terms: abuse or excessive requests may suspend API access; do not share tokens to exceed rate limits. | GitHub | <https://docs.github.com/en/site-policy/github-terms/github-terms-of-service> (section H) |
| npm registry and download counts (`registry.npmjs.org`, `api.npmjs.org`) | repo-radar | Download-count queries are limited to 18 months of data. We found no data licence statement. See the provider's terms. | npm | <https://github.com/npm/registry/blob/main/docs/download-counts.md> |
| OSV (`api.osv.dev`) | repo-radar | The OSV data page lists the licence of each source database (for example CC BY 4.0 for GitHub, PyPI and Go advisories, CC0 for the Rust advisory database); the licence depends on the entry's source. | Vulnerability data from OSV.dev and its listed sources | <https://google.github.io/osv.dev/data/> |
| Coroot HTTP API (`demo.coroot.com` by default, or the address you set) | coroot | Coroot is Apache-2.0 (<https://github.com/coroot/coroot>). The demo is Coroot's hosted instance, read anonymously; we found no data licence or rate limit on it. The API is the one Coroot's own UI uses and is not a versioned public API. See the provider's terms. | Coroot | <https://docs.coroot.com> |
| Prometheus HTTP API (`demo.promlabs.com` by default, or the address you set) | obs | Prometheus is Apache-2.0 (<https://github.com/prometheus/prometheus>). The demo is PromLabs' hosted instance, read anonymously; we found no data licence or rate limit on it. See the provider's terms. | Prometheus | <https://prometheus.io/docs/prometheus/latest/querying/api/> |
| AWS CLI (`aws cloudwatch describe-alarms`, run on your computer) | obs | Run by you with your own AWS sign-in; no data leaves your computer except what the AWS CLI sends to AWS. The AWS CLI is Apache-2.0. See AWS's terms. | AWS | <https://docs.aws.amazon.com/cli/latest/reference/cloudwatch/describe-alarms.html> |
| VictoriaMetrics playground (`play.victoriametrics.com`) | obs | VictoriaMetrics is Apache-2.0. A public playground read anonymously through its Prometheus-compatible API; we found no data licence or rate limit on it. See the provider's terms. | VictoriaMetrics | <https://docs.victoriametrics.com/> |
| Grafana play (`play.grafana.org`) | obs | Grafana is AGPL-3.0; obs only reads its HTTP API. A public demo read anonymously for alert rules; we found no data licence or rate limit on it. See the provider's terms. | Grafana Labs | <https://grafana.com/docs/grafana/latest/developers/http_api/> |
| Netdata public demo (`london.my-netdata.io`) | obs | Netdata is GPL-3.0; obs only reads its HTTP API. A public demo agent read anonymously for active alarms; we found no data licence or rate limit on it. See the provider's terms. | Netdata | <https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api/queries> |
| Status pages (`githubstatus.com`, `cloudflarestatus.com`, `status.openai.com`) | obs | Public vendor status pages served by Atlassian Statuspage or a compatible format; component and incident status read without a key. We found no data licence stated. See each vendor's terms. | GitHub, Cloudflare, OpenAI | <https://developer.statuspage.io/> |
| Art Institute of Chicago (`api.artic.edu`, `www.artic.edu`) | script-template | Data from the public API and images marked "CC0 Public Domain Designation" are CC0. Other text, images and site content may be protected; the API docs warn that some images are not public domain and the user must check. The example asks for public domain works only. | The Art Institute of Chicago | <https://www.artic.edu/terms>, <https://www.artic.edu/image-licensing>, <https://api.artic.edu/docs/> |
| NASA Astronomy Picture of the Day (`api.nasa.gov`) | around (a free key is required, never `DEMO_KEY`); feed-template (template setting, off until you add a key) | NASA says its content generally is not subject to copyright in the United States and may be used without permission in a factual way that does not imply endorsement; NASA should be acknowledged as the source. The APOD page says some of its images are credited to other owners and are copyrighted, and neither NASA nor APOD can grant permission for those. Check the provider terms for the key itself. | Astronomy Picture of the Day, NASA, and the credit line the response gives for each picture | <https://www.nasa.gov/nasa-brand-center/images-and-media/>, <https://apod.nasa.gov/apod/lib/about_apod.html>, <https://api.nasa.gov/> |

## Sites only linked to

Some rows and the apps under `apps/` open a web page in your browser when you press Open:
caniuse.com, nvd.nist.gov, cve.org, npmjs.com, github.com, news.ycombinator.com, science.nasa.gov and
openstreetmap.org. Opening a page is your choice, and that site's own terms and privacy
policy apply. Nothing is fetched or stored by us.

## Placeholder addresses

Addresses such as `api.example.com` and `app.example.com` in templates and fixtures are
reserved example addresses (RFC 2606). They are not real services.

## Pictures in docs/images

The pictures are screenshots we took of Bolt running the example apps, and animated
recordings of the same screens.

| Picture | What it shows | Third-party content in it |
|---|---|---|
| `acme-dash-*`, `expense-tracker-*`, `pipeline-board-*`, `places-list-*`, `unit-convert-*`, `terminal-*`, `install-*` | The apps on invented sample data (labelled SAMPLE in the pictures), the install card and terminal output. | None beyond Bolt's own interface. |
| `sky-watch-*` | Live results from Open-Meteo, Launch Library 2, USGS and wheretheiss.at on the day of capture. | Facts and figures from those providers (see the table). |
| `pulse-feed-*` | Live Hacker News front-page titles and scores on the day of capture. Author user names are blurred. | Short public headlines from Hacker News posts. |

All screenshots also show Bolt's own interface, which belongs to Sparcle Inc. and is not under
the Apache License of this repository. They are illustrations only. If you are an author or
provider shown and want a picture changed or removed, write to bolt@sparcle.app.

No third-party artwork is shipped in this repository (we found no image files outside
`docs/images`). The `around` and `script-template` examples may show pictures or text from
OpenStreetMap, Wikipedia and the Art Institute when you run them live; those come from the
providers at run time and are not stored here.
