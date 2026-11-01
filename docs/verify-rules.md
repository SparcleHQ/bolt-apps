# Where `bolt-apps verify` gets its rules

`schema/install-rules.json` holds the install rules Bolt enforces on a pack-installed User App, as data: the allowed runtimes, action kinds, `emits` kinds, widgets, parse modes, the top-level keys Bolt accepts, the admin-only keys it refuses, the shell characters it forbids in a command, the pack limits and which entry kinds the launcher drop installs. `conformance/verify-cases.json` holds cases that edit a known-good app and name the finding `verify` must report. For the YAML rules each case also carries `bolt_error_contains`, the text Bolt's own parser puts in the load error.

The source of truth is Bolt: `bolt-native` `src-tauri/src/user_utilities/contract.rs`, `pack_validate.rs`, `pack_install.rs` and `bolt-common` `bolt-manifest-verify`. The data file is a mirror, read on 2026-11-01.

## What `verify` does not do

It reads YAML with plain text rules, not Bolt's parser. It does not check `presentation` fields, `inputs`, `transform.pipe` steps, `recognize` regexes, reserved ports, env-variable rules or the schema of the rows a script prints (use `check` for that). A pass means none of the known ways to fail were found.

## Keeping Bolt and this repo equal

Today nothing in Bolt reads these two files, so they can drift. The fix needs a `bolt-native` change, so it is a proposal:

1. `bolt-native` `src-tauri/src/user_utilities/contract.rs` gets a test that loads `schema/install-rules.json` (vendored under `src-tauri/testdata/` with a sha256 pin, the same way `env-placeholder-cases.json` is shared with bolt-pwa) and asserts each list equals the Rust constant: `ALLOWED_RUNTIME`, `ALLOWED_ACTION_KIND`, `ALLOWED_EMITS`, `ALLOWED_WIDGET`, `ALLOWED_PARSE`, `ALLOWED_HTTP_LOCAL_HOSTS`, `ALLOWED_HTTP_METHOD`, `FORBIDDEN_SHELL_CHARS`, `MAX_SCHEMA_VERSION`, the top-level field names of `UserUtilityContract`, `MAX_PACK_ENTRIES`, `MAX_UNPACKED_BYTES`.
2. The same test builds each case of `conformance/verify-cases.json` and runs the YAML through `loader::parse_str_for_pack`: a case with `bolt_error_contains` must return `Err` containing that text, a case with no `expect` must return `Ok`.
3. This repo's CI already runs the same cases through `verify`, so a change on either side that breaks the other fails a test.

Files in `bolt-native`: `src-tauri/src/user_utilities/contract.rs` (test module), `src-tauri/testdata/bolt-apps-install-rules.json`, `src-tauri/testdata/bolt-apps-verify-cases.json`. The site's rule pages should be generated from `schema/install-rules.json` rather than typed by hand.
