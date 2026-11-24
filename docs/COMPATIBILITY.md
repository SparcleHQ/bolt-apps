# Compatibility

What stays working when Bolt moves from one version to the next, and what an older Bolt does with an app that uses something newer.

## Older apps keep working in 184

An app that ran on Bolt 0.1.181, 0.1.182 or 0.1.183 keeps running on Bolt 0.1.184 with no change. The 0.1.184 widgets are added keys and kinds; none of them changes what an existing key means. This is the promise for 184. An existing app does not need a new `min_bolt_version`, a rebuild or a new pack to keep working.

## Newer apps on an older Bolt

`min_bolt_version` in `bolt-app.json` is a promise from you, the author. Bolt does not read it, so it cannot hold a pack back.

A Bolt older than a widget does not know its key or kind. It refuses the WHOLE pack with an unknown-key error, so no app in that pack installs. It does not fall back to a plainer widget.

So:

- Give a pack that uses a new widget only to people on a Bolt that has it (184 or newer for the 0.1.184 widgets).
- Split packs so an old app is never held back by a new one. Keep apps that use 0.1.184 widgets in their own pack, and keep older apps in a pack of their own.
- Large demo apps that use the new widgets (showcase and obs-rich) ship as their OWN packs and are never bundled with older apps.
- Set `min_bolt_version` to the version that introduced the widget. The toolkit helps: `bolt-apps check` and `bolt-apps verify` report an error (`bind_needs_newer_bolt`) when an app uses a key or kind that a newer Bolt introduced and `bolt-app.json` does not declare that version. When only a built pack is read without its listing, the same finding is a warning. The declaration is still only your promise.

Each widget's `since` version is in `schema/bolt-rules.json` and in `kit/examples/CAPABILITIES.md`.

## What has been proven

The compatibility proof for 184 (older apps against the 184 rules) is produced separately. Its verdict is linked here once it is published. Until then this page promises only what is above and does not state a result.
