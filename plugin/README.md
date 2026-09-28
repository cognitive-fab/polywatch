# polywatch (Claude Code plugin)

Background review of the code Claude Code writes. After each turn a reviewer from another model family lists candidate defects, Claude Opus checks the serious ones against the code, and only confirmed defects go back to Claude.

This folder is what the plugin installs. Documentation, configuration, the benchmark and the research scripts live in the repository: https://github.com/cognitive-fab/polywatch

## What leaves your machine

- The changed code of each turn goes to the reviewer's API: DeepSeek by default (`api.deepseek.com`), with your DeepSeek key.
- Single claims with the code they cite go to the confirming model: through `claude -p` on your Claude plan (`"provider": "claude-code"`), or the Anthropic API with your Anthropic key.
- Each key is sent only to its own vendor. Keys are set in the plugin's settings (stored in your system credential store) or named in `~/.polywatch.json`.
- Files matching `exclude` (`.env`, `*.pem`, `*secret*`, `*credential*`, …) are never sent.
