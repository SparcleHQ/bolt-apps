# Contributing a Bolt App

> **The gallery is not open yet, and contributions are not accepted.** This guide describes
> how it will work. Pull requests from outside Sparcle are closed until the gallery opens
> (see the [README](README.md)).

AI coding agents: read [AGENTS.md](AGENTS.md) instead; it is the same process in a stricter
form.

## 1. Build it in Bolt

Make the app the way you would for yourself, and use it for a few days.

- **Snippet:** Settings, Search & Commands, Snippets.
- **Search engine:** Settings, Search & Commands, Search Engines.
- **User App:** a `runtime: transform` YAML file in your User Apps folder (Settings,
  Desktop App, User Apps, Open folder).

Reference: [Extend Bolt](https://sparcle.app/docs/extend/).

## 2. Write the app folder

Either use **Share to gallery** in Bolt when it ships, which writes the folder for you, or
make it by hand:

```
apps/<id>/
  bolt-app.json              what it is, who it is for, what it saves, tier, permissions, tests
  README.md                  a short page: what it does, an example, its permissions
  snippets/<key>.json        if it has a snippet
  search_engines/<id>.json   if it has a search engine
  utilities/<id>.yaml        if it has a User App
```

`<id>` is lowercase letters, digits and dashes, and matches the folder name. The shape of
`bolt-app.json` is in [`schema/bolt-app.schema.json`](schema/bolt-app.schema.json) and
explained in [CHECKER.md](CHECKER.md).

Use made-up data everywhere: `@example.com` addresses, `ACME-123` style IDs, no real names,
no keys or tokens, no internal links.

## 3. Run the checker

```
bolt-apps check apps/<id>
```

It loads your app with Bolt's own code in a clean setup, runs your tests, works out the
tier and the permissions, and looks for secrets and personal data. Fix every error. Paste
its output into your pull request. [CHECKER.md](CHECKER.md) lists every finding code.

## 4. Open a pull request

One app per pull request. Use the template; it asks for the kind, tier, permissions, what
the app saves, the checker output, and confirmation that you used demo data only. Sign off
every commit (`git commit -s`), see [Licence](#licence) below.

## Review

1. The checker runs again in CI. A red check blocks the merge.
2. A person at Sparcle takes a quick look for safety and quality, usually within a week.
3. When it is merged it appears in the gallery. An app a Sparcle reviewer checked gets the
   `reviewed` label, shown as **Reviewed by Sparcle**: Sparcle checked this version's
   declared permissions and behaviour. It is not a guarantee.

Votes (thumbs-up reactions) and comments are welcome on any pull request. They are
recognition; they do not decide whether an app is accepted.

## What gets rejected

- Anything the checker refuses (see [CHECKER.md](CHECKER.md)).
- Tier 3 content (commands, files, network, AI agent tools) without a Sparcle review.
- Real personal data, customer data, secrets, keys, tokens or internal links.
- An app that copies another one without adding anything, or drops the original author's
  credit (keep `derived_from`).
- An app that impersonates a company, a product or a person, or misleads about what it does.
- Anything against the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

This repository is licensed under the [Apache License 2.0](LICENSE). By contributing you
agree your contribution is licensed under it too.

Every commit must carry a Developer Certificate of Origin sign-off
([developercertificate.org](https://developercertificate.org/)), a line at the end of the
commit message that says you have the right to submit the work:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. Use the name and email you want credited.

A DCO check runs on every pull request ([`.github/workflows/dco.yml`](.github/workflows/dco.yml))
and fails if any commit lacks a sign-off. To fix it, sign off the missing commits and push
again:

```
git rebase --signoff origin/main
git push --force-with-lease
```

## Credit and spotlights

Your name and link from `bolt-app.json` are shown on the app's card and on Bolt's install
screen. We feature authors in a monthly spotlight only if you tick the spotlight box in
the pull request template; you can withdraw at any time by commenting on your pull
request. There is no payment or prize for contributing.
