# Labels

Create these once (Settings, Labels, or `gh label create`). Workflows and reviewers apply
them; contributors do not need to.

| Label | Colour | Meaning |
|---|---|---|
| `tier-1` | `#c5def5` | Data only: snippets, search engines |
| `tier-2` | `#bfd4f2` | Acts inside Bolt: transform User Apps |
| `tier-3` | `#5319e7` | Touches the system or network. Accepted only with `reviewed` |
| `kind:snippet` | `#ededed` | Has a snippet |
| `kind:search-engine` | `#ededed` | Has a search engine |
| `kind:user-app` | `#ededed` | Has a User App |
| `reviewed` | `#0e8a16` | Shown as "Reviewed by Sparcle": Sparcle checked this version's declared permissions and behaviour. It is not a guarantee |
| `community-favourite` | `#fbca04` | Recognition from reactions. Changes nothing else |
| `idea` | `#d4c5f9` | An app idea (issue template) |
| `bug` | `#d73a4a` | A bug in an app (issue template) |
| `checker-failed` | `#b60205` | The checker failed on the latest commit |

```sh
gh label create tier-1 --color c5def5 --description "Data only"
gh label create tier-2 --color bfd4f2 --description "Acts inside Bolt"
gh label create tier-3 --color 5319e7 --description "Touches the system or network; needs review"
gh label create kind:snippet --color ededed
gh label create kind:search-engine --color ededed
gh label create kind:user-app --color ededed
gh label create reviewed --color 0e8a16 --description "Reviewed by Sparcle"
gh label create community-favourite --color fbca04 --description "Recognition only"
gh label create idea --color d4c5f9
gh label create bug --color d73a4a
gh label create checker-failed --color b60205
```
