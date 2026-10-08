# polywatch privacy policy

Effective 2026-10-07. Applies to the polywatch plugin for Claude Code, published by Jean-Jacques Dubray at [github.com/cognitive-fab/polywatch](https://github.com/cognitive-fab/polywatch).

## In short

- polywatch has no server. It sends nothing to its authors: no telemetry, no analytics, no crash reports.
- To review the code Claude Code writes, it sends that code, and your latest request, to the model providers **you** configure, under **your** accounts with them.
- Everything it keeps stays on your machine.

## What is sent, and to whom

After each Claude Code turn that changes code, polywatch sends:

| What | Limit | Sent to |
|---|---|---|
| The source files changed in the turn, with their paths inside the project | 60,000 characters per file; at most 20 files found by change detection | The **reviewer**: Anthropic by default (Claude Haiku 5.5, `api.anthropic.com`), or the provider you choose (for example DeepSeek, `api.deepseek.com`). With `compare` set in your own settings, a second reviewer receives the same |
| Your most recent request to Claude Code | 4,000 characters | The reviewer, and the confirming model |
| Each serious claim the reviewer makes, with an excerpt of the code it cites | 40,000 characters per claim | The **confirming model**: Anthropic, either through your local Claude Code (`claude -p`, on your Claude plan) or the Anthropic API |

polywatch does not send:

- files matching its exclude list: `.env`, `.env.*`, `*.pem`, `*.key`, `*secret*`, `*credential*`, `node_modules/`, `.git/`, `.polywatch/`, and any patterns you add;
- files outside the project folder;
- anything from projects outside the folders you allow, when you set `onlyUnder`;
- your API keys, except each key to its own provider (below);
- test output, the dashboard, or anything it stores locally.

If you choose DeepSeek for a reviewer: DeepSeek is a third-party model provider based in China. What DeepSeek and Anthropic do with the data they receive is governed by your agreement with them and their privacy policies, not by polywatch.

## Your API keys

Keys are set as sensitive plugin settings, which Claude Code keeps in your operating system's credential store, or read from an environment variable you name in `~/.polywatch.json`. The DeepSeek key is sent only to DeepSeek; the Anthropic key only to Anthropic. A repository's own `.polywatch.json` cannot change where keys are sent, which variable they are read from, or which command runs on your machine.

When polywatch runs the local `claude -p`, it removes Anthropic API credentials from that process's environment, so the call uses your Claude plan login.

## What is stored on your machine

| Where | What |
|---|---|
| `<project>/.polywatch/` | For each reviewed turn: the edits recorded, the request text, review results with the reviewer's claims and code excerpts, the outcomes you or Claude recorded, and an optional HTML dashboard. polywatch adds a `.gitignore` there so none of it is committed. |
| `~/.polywatch.json` | Your settings. |
| `~/.polywatch-spend/` | One file per day with the amount spent on your API accounts, used for the daily cap. |

Nothing is deleted automatically. Deleting these folders deletes all of it.

## Your controls

- Choose each step's provider: `"provider": "claude-code"` or `"anthropic"` keeps everything with Anthropic; a `baseUrl` in `~/.polywatch.json` points the reviewer at a model server you run yourself.
- Add exclude patterns; limit polywatch to chosen folders with `onlyUnder`.
- Turn the plugin off in `/plugin`, or remove it.

## Children

polywatch is a developer tool and is not intended for anyone under 18.

## Changes and contact

Changes to this policy are made in this file, and its history is public in the repository. Questions: open an issue at [github.com/cognitive-fab/polywatch/issues](https://github.com/cognitive-fab/polywatch/issues).
