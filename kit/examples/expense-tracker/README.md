# Expense tracker
**What this shows:** summary tiles with a budget meter, a category list that drills into its expenses, a detail pane per expense and a bar chart per day
**Edit these files:** `scripts/expense-tracker__config.json` (`stats`, `overview`, `views`) and `scripts/expense-tracker__fixtures.json` (`expenses`, `categories`, `daily`).
**Run these commands** from the repo root (once before the first pack: `./bolt-apps keygen`; a higher `--version` each pack):
```
./bolt-apps lint kit/examples/expense-tracker --personal
./bolt-apps check kit/examples/expense-tracker
./bolt-apps pack kit/examples/expense-tracker --personal --version 1.0.1 --out ../expense-tracker-1.0.1.boltpack
./bolt-apps verify ../expense-tracker-1.0.1.boltpack
```

## Notes
Adding an entry from the launcher is a different pattern (a form): see `form-template`. The engine runs either a views app or a form app, not both in one, so this example only reads.

Sample data is invented. The app calls `https://api.example.com`, which does not exist: point `api.base_url` and `endpoints[].path` at your own API, or keep using fixture mode in `check.json`. See `../ENGINE.md` for every option.

After editing `config.json`, rebuild the app file: `./bolt-apps regen <this app folder>`. Drop the `.boltpack` on the Bolt launcher or Bolt Apps; the key never goes in the pack (see ENGINE.md, "Where to store keys").
