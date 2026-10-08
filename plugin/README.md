# polywatch (Claude Code plugin)

Background review of the code Claude Code writes. After each turn a reviewer from another model family lists candidate defects, Claude Opus checks the serious ones against the code, and only confirmed defects go back to Claude.

This folder is what the plugin installs. Documentation, configuration, the benchmark and the research scripts live in the repository: https://github.com/cognitive-fab/polywatch

## What leaves your machine

The full privacy policy is in [PRIVACY.md](PRIVACY.md).


- The changed code of each turn goes to the reviewer's API: Anthropic by default (Claude Haiku 5.5), with your Anthropic key; DeepSeek (`api.deepseek.com`) with your DeepSeek key if you choose it, as reviewer or as a second `compare` reviewer.
- Single claims with the code they cite go to the confirming model: through `claude -p` on your Claude plan (`"provider": "claude-code"`), or the Anthropic API with your Anthropic key.
- Each key is sent only to its own vendor. Keys are set in the plugin's settings (stored in your system credential store) or named in `~/.polywatch.json`.
- Files matching `exclude` (`.env`, `*.pem`, `*secret*`, `*credential*`, …) are never sent.

## What it costs, and the caps

Reviews run on your own API accounts. A reviewed turn typically costs $0.01 to $0.15; confirmation through `claude -p` (`"provider": "claude-code"`) runs on your Claude plan and costs no API money.

- **Per turn:** at most $0.50 (`budgetUsdPerTurn`).
- **Per day:** at most $5 across all projects (`budgetUsdPerDay`). Once reached, reviews are skipped with a note until the next day.
- A repository's own `.polywatch.json` can lower these caps but never raise them; only your `~/.polywatch.json` can.
- Set spending limits with your providers as well. `polywatch stats` and the dashboard show what was spent.

The software is provided under the Apache License 2.0, "AS IS", without warranties (sections 7 and 8).
