# Where `bolt-apps verify` gets its rules

`schema/install-rules.json` holds the install rules Bolt enforces on a pack-installed User App, as data: the allowed runtimes, action kinds, `emits` kinds, widgets, parse modes, the top-level keys Bolt accepts, the admin-only keys it refuses, the shell characters it forbids in a command, the pack limits and which entry kinds the launcher drop installs. `conformance/verify-cases.json` holds cases that edit a known-good app and name the finding `verify` must report. For the YAML rules each case also carries `bolt_error_contains`, the text Bolt's own parser puts in the load error.

The source of truth is the launcher's own manifest contract, pack validation, pack installer and signature verifier. The data file is a mirror, read on 2026-11-01.

## What `verify` does not do

It reads YAML with plain text rules, not Bolt's parser. It does not check `presentation` fields, `inputs`, `transform.pipe` steps, `recognize` regexes, reserved ports, env-variable rules or the schema of the rows a script prints (use `check` for that). A pass means none of the known ways to fail were found.

## Keeping Bolt and this repo equal

Today nothing in Bolt reads these two files, so they can drift. The fix needs a launcher change, so it is a proposal:

1. The launcher's manifest contract gets a test that loads `schema/install-rules.json` (vendored into its test data with a sha256 pin) and asserts each list equals the launcher's own constant: `ALLOWED_RUNTIME`, `ALLOWED_ACTION_KIND`, `ALLOWED_EMITS`, `ALLOWED_WIDGET`, `ALLOWED_PARSE`, `ALLOWED_HTTP_LOCAL_HOSTS`, `ALLOWED_HTTP_METHOD`, `FORBIDDEN_SHELL_CHARS`, `MAX_SCHEMA_VERSION`, the top-level field names of `UserUtilityContract`, `MAX_PACK_ENTRIES`, `MAX_UNPACKED_BYTES`.
2. The same test builds each case of `conformance/verify-cases.json` and runs the YAML through the launcher's pack manifest parser: a case with `bolt_error_contains` must return `Err` containing that text, a case with no `expect` must return `Ok`.
3. This repo's CI already runs the same cases through `verify`, so a change on either side that breaks the other fails a test.

Files on the launcher side: the contract's test module and two vendored test data files, one for the rules and one for the verify cases. The site's rule pages should be generated from `schema/install-rules.json` rather than typed by hand.

## Bolt said X, do Y

Every refusal Bolt's installer and loader can give a personal pack, with the fix in plain words. `bolt-apps ship` prints the common ones and `bolt-apps doctor --bolt-says` prints all of them. A test keeps this table equal to the one in the toolkit.

| Bolt says | Code | What to do |
|---|---|---|
| Bolt did not install this pack because this version, or a newer one, is already installed. Nothing was changed. To go back to an older version, remove the installed apps first. | `same_or_older_version` | Run bolt-apps ship again: it picks a higher version by itself. If you passed --version, use a higher number than the one installed. |
| This pack cannot be installed here. Nothing was changed. (181 has no special wording for this; the reason is in the log: it cannot tell whether this is newer than the installed version.) | `version_unreadable` | A version is numbers with dots, such as 1.0.5. Run bolt-apps ship without --version. |
| Bolt did not install this pack because one of its files already belongs to another installed pack. Nothing was changed. Remove that other app first if you want this one instead. | `owned_by_other` | Another installed app owns a script file with that name. Rebuild with the current bolt-apps: every file is named <app id>__<name>. Or remove the other app first. |
| Bolt did not install this pack because a file with the same name as one of its scripts is already in your folder and no pack installed it. Nothing was changed. | `file_exists` | A file with that name in your scripts folder was added by hand or came with Bolt. Open it (Settings, Desktop App, User Apps, Open folder) and delete it, or rename yours. |
| Bolt did not install this pack because one name in it is used both as a file and as a folder, which no computer can store. Nothing was changed. | `file_and_folder` | Rename the file or the folder inside scripts/ so one name is not both. |
| Bolt did not install this pack because two of its files differ only in capital letters, so one would replace the other on this computer. Nothing was changed. | `case_collision` | Rename one of the two files: macOS and Windows treat them as one file. |
| Bolt did not install this pack because one of its files is inside too many folders. Nothing was changed. (The dialog adds the hint: Ask the pack's author to use fewer folders (at most 8).) | `too_deep` | Keep scripts flat, directly in scripts/ (bolt-apps new does this). |
| Bolt did not install this pack because one of its files has a path that could reach outside the scripts folder. Nothing was changed. | `unsafe_path` | Remove . or .. or odd characters from the script name; use letters, digits, . _ and -. |
| Bolt did not install this pack because something in your scripts folder is in the way of one of its files (a file where a folder is needed, a folder where a file goes, or a link). Nothing was changed. | `in_the_way` | Open your folder (Settings, Desktop App, User Apps, Open folder) and remove the file, folder or link that has the same name. |
| Bolt did not install this pack because a file named scripts sits in your user apps folder, so the scripts folder cannot be made. Nothing was changed. | `scripts_is_a_file` | Move that file away from your user apps folder, then drop the pack again. |
| Bolt did not install this pack because it could not write one of its files to your user apps folder. Files it had already written for this install were removed; files from an earlier version of the pack may be unchanged. | `write_failed` | Free some disk space or check you can write to your Bolt folder, then drop the pack again. |
| Bolt did not install this pack because its list of installed packs could not be read, and installing now could lose track of the packs already installed. Nothing was changed. | `ledger_unreadable` | Do not delete anything. Ask for help with the file .boltpack-installs.json in your user apps folder. |
| This pack cannot be installed here. Nothing was changed. (181 has no special wording for this; the reason is in the log.) | `signature_recheck` | Build the pack again with bolt-apps ship and drop the new file; do not copy a pack between folders while Bolt reads it. |
| This pack could not be verified: its contents do not match its signature. It was not installed. | `unverified` | The pack was changed or damaged after signing. Run bolt-apps ship again and drop the new file; never edit a .boltpack. |
| This pack could not be verified, so it was not installed. Check that the file is a complete, unmodified .boltpack. | `outside_pack` | Build the pack with bolt-apps ship, not by hand. |
| Install cancelled. Nothing was changed. | `cancelled` | You chose Cancel on the review card or on Bolt's "Install an unverified Bolt pack?" dialog. Drop the pack again and choose Install if you trust the app. |
| Your organization's policy on this device installs only packs signed by Sparcle. This pack is signed by its author, so Bolt did not install it. Ask your IT team if you need it. Nothing was changed. | `org_policy` | A company policy blocks personal apps on this computer. Nothing is wrong with the app; ask your admin, or use a computer without that policy. |
| Not loaded: this app's files do not match the signed pack Bolt recorded for it | `not_loaded_changed` | A script was edited after install. Run bolt-apps ship again and drop the new pack; it replaces the changed files. |
| an empty list after install: nothing is shown when you press Enter on the app | `not_approved_yet` | The app is not approved yet (Bolt 181 shows an empty list instead of saying so). Open Bolt Settings, Desktop App, User Apps, expand the app, click Review and accept. If User Apps is not listed, switch Settings to Advanced. Every reship changes the files, so you approve again. |
| this app's command names a file in Bolt's scripts folder directly | `scripts_direct` | Write every script as {{scripts_dir}}/<app id>__<file> in the app file, never a full path. bolt-apps lint --personal shows the line. |
| the app names its scripts in a form Bolt cannot resolve to one file each / is missing / is a link / is too large to check | `cannot_check` | Name each script once as {{scripts_dir}}/<app id>__<file>, keep each under 2 MB, no links, and make sure the file is in scripts/. bolt-apps verify names the file. |
| This pack could not be verified, so it was not installed. Check that the file is a complete, unmodified .boltpack. | `pack_too_big` | An app is small text and scripts. Remove big files from the app folder. |
| This pack could not be verified, so it was not installed. Check that the file is a complete, unmodified .boltpack. | `pack_unreadable` | The file is not a .boltpack or is damaged. Run bolt-apps ship again and drop the new file. |
| This pack could not be verified, so it was not installed. Check that the file is a complete, unmodified .boltpack. | `not_valid_app` | Run bolt-apps verify on the app folder: it names the line in the app file to fix. |

### The backend sentences (log text)

The install dialog in Bolt 0.1.181 does not show these. It rewrites each one to a fixed sentence (the table above, read from the 181 launcher's pack install error rewrite); a refusal it cannot place shows "This pack cannot be installed here. Nothing was changed." These are the sentences the desktop writes to `bolt-startup.log`, so search the log for them.

`<name>`, `<new>`, `<old>`, `<file>` and `<other app>` stand for what Bolt fills in.

| Code | Backend sentence (log text) |
|---|---|
| `same_or_older_version` | Bolt did not install `<name>` `<new>`: version `<old>` is already installed, and a pack is only replaced by a newer version. To go back to an older version, remove the installed apps first. |
| `version_unreadable` | Bolt did not install `<name>` `<new>`: it cannot tell whether this is newer than the installed version `<old>`. Remove the installed apps first to install this version. |
| `owned_by_other` | Bolt did not install `<name>`: `<file>` already belongs to `<other app>`. Remove that app first if you want this one instead. |
| `too_deep` | Bolt did not install `<name>`: `<file>` is nested more than 8 folders deep. Ask the pack's author to use fewer folders. |
| `org_policy` | Your organization's policy on this device installs only packs signed with a key built into Bolt (...). `<name>` is signed only by its author, so Bolt did not install it. ... Ask your IT team if you need it. (The dialog shows the fixed sentence above.) |

Name lengths: Bolt accepts up to 128 characters per file or folder name and 512 for a whole path, and an app id is up to 64 characters. Every script starts with `<app id>__`, so `<app id>__<name>` must fit in 128. This toolkit packs a script name of at most 82 characters, because it writes the path `manifests/scripts/<name>` into a 100-character field.

### Rules the examples had to follow

- Chip equals id (`chip_not_id`): the launcher looks apps up by id (Bolt 181 and main), so an app whose chip differs from its id is offered in the launcher but never runs: an empty list and no error. Set `chip` to the id.
- First-run approval: the dialog lists "Mentions" lines (a web address with a user name or a backslash; the system keychain or the security command) for the vendored kit file of EVERY kit app, even one that never uses a key or the network. That is the kit's own text, not the app's logic; a kit provided by Bolt (planned for 182) removes it. After you drop a pack, open Settings, Desktop App, User Apps, expand the app and click Review and accept; every reship changes the files, so you approve again.
- Right pane checks (`check`): the tile limits and the per-row pane rules are in [the rules table](../kit/examples/QUICKSTART.md#4-the-rules-table). `empty_tile_grid` flags a run of 8 or more rows where half carry no value in the bound value field (the floor keeps a lone setup or error row from being refused).
- `tile_row_without_value` (`check`): in a tiles view (cards, `bind.layout: tiles`) every row must carry a value in the bound value field (Bolt draws a tile for every row, a refresh or Back row included, so none is exempt: give a refresh row a number such as `kpi_label` Data age, `kpi_value` seconds since the copy was made, or keep refresh and Back rows in a view that is not a tiles grid), unless the run has no data row at all (a lone setup, error or retry state). A label or hint belongs on a real tile (badge or footer). There is no waiver: a `check.json` that carries the old `known_empty_tiles` key fails with `waiver_removed`. Use an `entity_preview` pane (a tile draws only for a number) for rows that have text only.
- `no_rows`, `too_few_rows`, `row_title_empty`, `row_subtitle_empty` (`check`, every case): a run must print at least one row, every row needs a title, and in a shared-engine app every row needs a non-empty subtitle. `expect.min_rows` sets a floor.
- `sample_marker_missing` (`check`): an app whose config sets `api.fixture_banner` and that is running on sample data must have a visible row that says "sample".
- `case_unknown_view` (`check`): in a shared-engine views app, a case whose first word is not a view (and not `overview`, or a `demo-` word) fails, because the engine would draw the overview and the case would test nothing. `expect.view_fallback: true` marks a case that tests that fallback on purpose.

