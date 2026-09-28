---
name: trust
description: Show the defects polywatch found in the code written in this project, ranked, with Opus's evidence for confirmed ones. Use when the user asks what polywatch found, asks for the polywatch report, or says whether a reported finding was a real bug or a false alarm.
---

# polywatch findings report

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/polywatch.mjs" report` from the project root (set `POLYWATCH_LAST=20` for more history).
2. For each review, present the files, the tier, and the findings in rank order. For each finding say whether Opus confirmed it (with its evidence) or it is only the reviewer's claim, and how often findings of that kind have turned out real in this project. Mention hidden and refuted counts in one line; do not list them.
3. Do not present the reviewer's overall verdict or any pass/fail judgement of the change. polywatch is a bug hunter, not a gate: in replays of real history its verdict rejected clean and later-fixed commits at the same rate.
4. When the user says a finding was real or a false alarm, record it: `node "${CLAUDE_PLUGIN_ROOT}/bin/polywatch.mjs" outcome <reviewId> <findingNumber> real|false "<note>"`. These outcomes set the ranking weights. `polywatch calibration` shows the current weights.
5. If a confirmed finding is in code that is still open in this session, offer to fix it.
