# polywatch architecture

A background bug hunter for the code Claude Code writes: a cheap reviewer lists defects, Opus confirms the serious ones, and the user sees at most two.

**Read from.** bin/, src/, hooks/, skills/, scripts/ (code); README.md (document).

> Generated from the analysis by archlens. Edit the analysis, never this file.

## What this architecture answers

### What happens after Claude edits code

**What does polywatch do between one Claude turn and the next prompt?**

polywatch has to stay out of Claude's way. A review takes seconds to minutes, and a hook that waited for it would stall every turn. The design question is where the review runs and when its result reaches anyone.

It records each edit, starts a detached review when the turn ends, and shows the result on the next prompt. Claude never waits for it.

[Open the diagram](turn.sequence.html). 7 participants.

| Component | Responsibility |
|---|---|
| **Claude Code** | Runs the coding turns and calls polywatch's hooks at each event. |
| **Hook entry** | Handles each hook event in under a second and returns control to Claude Code. |
| **Review worker** | Runs one review pipeline per turn, from routing to ranked result. |
| **DeepSeek Flash** | Lists specific, checkable defects in the changed files. |
| **Claude Opus 5.5** | Decides whether one claimed defect holds against the cited code and the request. |
| **Review results** | Holds one result per reviewed turn until it is delivered. |
| **Delivery** | Decides what the user sees and what goes back to Claude. |

**Deliberately not shown.** The turn log, router, ranker, settings and ledger, which the hooks and worker use along the way, and the tests, which run only on HARD changes.

In order:

*during the turn*

1. **Claude Code → Hook entry**: PostToolUse: file edited. Hook JSON with the tool name, file path, and old and new text. The hook appends the edit to the turn log.

*turn ends*

2. **Claude Code → Hook entry**: Stop. Hook JSON with the session id and transcript path. The hook writes the job (edits plus the last user request).
3. **Hook entry → Review worker**: spawn, detached. The job file path. The Stop hook returns at once; Claude never waits on the review.

*in the background*

4. **Review worker → DeepSeek Flash**: list defects. Contents of changed files (excluded files never sent) and the request text; back comes JSON with issues, each with file, place, severity and claim.
5. **DeepSeek Flash ⇢ Review worker**: issues as JSON
6. **Review worker → Claude Opus 5.5**: check claim (up to 2). One claim, the cited code or windows around it, and the request when short; back comes holds yes, no or uncertain with evidence.
7. **Claude Opus 5.5 ⇢ Review worker**: holds + evidence
8. **Review worker → Review results**: write ranked result. Tier, findings, the top ones shown, confirmed issues, refuted count, cost and notes.

*next prompt*

9. **Claude Code → Hook entry**: UserPromptSubmit. Hook JSON with the session id and the user's new prompt.
10. **Hook entry → Delivery**: collect results. The session id and settings, at UserPromptSubmit and SessionStart.
11. **Delivery → Review results**: read undelivered. Results for this session not yet shown; marked delivered afterwards.
12. **Hook entry → Claude Code**: top 2 + confirmed. systemMessage for the user (top findings or 'nothing worth your attention'); additionalContext for Claude with confirmed findings only.

#### The long read

Read the diagram top to bottom. During the turn, every time Claude edits or writes a file, Claude Code runs the PostToolUse hook. The hook appends the edit to a turn log on disk and returns; it does no review.

When the turn ends, Claude Code runs the Stop hook. The hook writes a job (the turn's edits and the last thing the user asked) and spawns the review worker as a detached process. Then it returns, and Claude is free. This is the only place the two timelines split: from here on, Claude and the worker run independently.

In the background, the worker reads the job and sends the changed files to DeepSeek Flash, which lists the defects it sees. The worker sends up to two of the most serious claims, one at a time, to Claude Opus 5.5, which says whether each holds against the code and gives its evidence. Refuted claims are dropped, the rest are scored, and the ranked result is written to the results folder.

The result waits there until the user sends the next prompt. The UserPromptSubmit hook asks the delivery module for undelivered results and prints two things back to Claude Code: a short message for the user with at most two findings, and, for Claude, only the confirmed ones, so Claude can fix them in its next turn.

#### Terms used here

- **turn**: One round of Claude Code work: the user's prompt and everything Claude does in answer, up to when it stops.
- **hook**: A command Claude Code runs at a fixed event, such as after a file edit, when a turn stops, or when the user submits a prompt.
- **tier**: polywatch's label for how hard a change is to get right, from its size and whether it touches concurrency, state or protocol logic.
- **claim**: One specific, checkable statement a reviewer makes about a defect: which file, where, and what is wrong.
- **finding**: A claim that survived confirmation (it was not refuted), with a score. Confirmed findings carry Opus's evidence.
- **confirmed**: Opus checked the claim against the code and said it holds.
- **refuted**: Opus checked the claim against the code and said it does not hold. Refuted claims are never shown.
- **ledger**: An append-only file of every review and every outcome, used to calibrate the ranking.
- **additionalContext**: Text a hook returns that Claude Code adds to Claude's context for the next turn; polywatch uses it for confirmed findings.

### What happens to a claim

**Out of everything the reviewer says, what reaches the user and what reaches Claude?**

A cheap reviewer says a lot, and most of it is not worth a person's time. On real history its verdict carried no information at all, yet its specific claims sometimes named the exact bug a later commit fixed. The pipeline exists to keep those claims and drop the rest.

The reviewer's verdict is ignored. Opus checks the most serious claims and refuted ones are dropped. The ranker scores the rest by how often that kind of finding has been real. Delivery shows the top two, and only confirmed ones go to Claude.

[Open the diagram](filter.sequence.html). 7 participants.

| Component | Responsibility |
|---|---|
| **Review worker** | Runs one review pipeline per turn, from routing to ranked result. |
| **DeepSeek Flash** | Lists specific, checkable defects in the changed files. |
| **Claude Opus 5.5** | Decides whether one claimed defect holds against the cited code and the request. |
| **Ranker** | Scores each finding by how often findings of its kind turned out real. |
| **Ledger** | Keeps every review and every recorded outcome, in order, for calibration. |
| **Review results** | Holds one result per reviewed turn until it is delivered. |
| **Delivery** | Decides what the user sees and what goes back to Claude. |

**Deliberately not shown.** The router and tests, which only decide whether the project's tests run, and the hooks, which only carry the result.

In order:

*review*

1. **Review worker → DeepSeek Flash**: list defects. Contents of changed files (excluded files never sent) and the request text; back comes JSON with issues, each with file, place, severity and claim.
2. **DeepSeek Flash ⇢ Review worker**: verdict + issues. The verdict is stored and ignored. The issues are the candidates.

*confirm*

3. **Review worker → Claude Opus 5.5**: check top claim. High and medium issues, most severe first, up to two, within the per-turn budget.
4. **Claude Opus 5.5 ⇢ Review worker**: yes / no / uncertain. No drops the claim. Yes makes it a confirmed finding with evidence.

*rank*

5. **Review worker → Ranker**: score findings. Findings that survived confirmation; back comes each with a score, best first.
6. **Ranker → Ledger**: read outcomes. Past findings and the real or false outcomes recorded for them.
7. **Ledger ⇢ Ranker**: precision per kind
8. **Ranker ⇢ Review worker**: findings, best first

*show*

9. **Review worker → Review results**: top 2 above 0.25. Tier, findings, the top ones shown, confirmed issues, refuted count, cost and notes.
10. **Delivery → Review results**: read on next prompt. The user sees the shown findings; Claude gets only the confirmed ones, at most two turns in a row.

#### The long read

The worker runs the whole pipeline, in four phases. (Before them, the router labels the change EASY, MEDIUM or HARD; the label decides only whether the project's tests run, and no longer changes how findings are judged.)

The worker then sends the changed files to DeepSeek Flash. Flash returns a verdict and a list of issues. The verdict is stored but not used: in a replay of 50 commits it rejected almost everything, buggy or not. The issues are what matter.

The worker sorts the issues by severity and sends the top high and medium ones, up to two, to Claude Opus 5.5, one claim at a time, with the cited code. Opus answers yes, no or uncertain. A no removes the claim. A yes turns it into a confirmed finding and attaches Opus's evidence. Spending stops at the per-turn budget in the settings.

The ranker then scores what is left. Each finding falls into one of six kinds (confirmed or not, by severity), and each kind has a precision: a starting guess, moved by every outcome in the ledger. Findings below 0.25 are hidden. Delivery takes the top two, shows them to the user, and sends only the confirmed ones to Claude, for at most two turns in a row.

#### Terms used here

- **turn**: One round of Claude Code work: the user's prompt and everything Claude does in answer, up to when it stops.
- **hook**: A command Claude Code runs at a fixed event, such as after a file edit, when a turn stops, or when the user submits a prompt.
- **tier**: polywatch's label for how hard a change is to get right, from its size and whether it touches concurrency, state or protocol logic.
- **claim**: One specific, checkable statement a reviewer makes about a defect: which file, where, and what is wrong.
- **finding**: A claim that survived confirmation (it was not refuted), with a score. Confirmed findings carry Opus's evidence.
- **confirmed**: Opus checked the claim against the code and said it holds.
- **refuted**: Opus checked the claim against the code and said it does not hold. Refuted claims are never shown.
- **precision**: The share of findings of one kind that turned out to be real bugs, as estimated from recorded outcomes.
- **ledger**: An append-only file of every review and every outcome, used to calibrate the ranking.
- **outcome**: The user's verdict on one finding after the fact: real bug or false alarm.

### What leaves your machine

**Which parts of my code are sent to which provider?**

A code reviewer is a data flow. Anyone installing polywatch on a private codebase needs to know exactly what is sent where before the first turn is reviewed.

Only two calls leave the machine. The changed files (minus excluded ones) and the request go to DeepSeek. Single claims with the code they cite go to Anthropic. Everything else, including the ledger, stays in .polywatch/.

[Open the diagram](data.architecture.html). 7 components.

| Component | Responsibility |
|---|---|
| **Turn log and jobs** | Holds the edits of the current turn and the job the worker will review. |
| **Settings** | Supplies models, budgets, exclusions and ranking thresholds, merged over defaults. |
| **Review worker** | Runs one review pipeline per turn, from routing to ranked result. |
| **DeepSeek Flash** | Lists specific, checkable defects in the changed files. |
| **Claude Opus 5.5** | Decides whether one claimed defect holds against the cited code and the request. |
| **Review results** | Holds one result per reviewed turn until it is delivered. |
| **Ledger** | Keeps every review and every recorded outcome, in order, for calibration. |

**Deliberately not shown.** The replay scripts, which also call Anthropic but only on benchmark data.

#### The long read

Everything inside the box runs locally. The turn log, the settings, the results and the ledger are plain files in the project's .polywatch folder.

The first crossing is the review. The worker builds a prompt from the changed files and the user's request. Files matching the exclusion list (.env files, keys, anything named secret or credential, node_modules) are dropped before the prompt is built, and each file is capped at 60,000 bytes. The prompt goes to DeepSeek by default; the settings can point it at Anthropic or at a local OpenAI-compatible server instead.

The second crossing is confirmation. For each claim it checks, the worker sends Anthropic the claim, the cited file or the windows of it around the names the claim mentions, and the request when it is under 20,000 characters.

Nothing else leaves. The ledger of outcomes, which is what calibrates the ranking, never does.

#### Terms used here

- **turn**: One round of Claude Code work: the user's prompt and everything Claude does in answer, up to when it stops.
- **tier**: polywatch's label for how hard a change is to get right, from its size and whether it touches concurrency, state or protocol logic.
- **claim**: One specific, checkable statement a reviewer makes about a defect: which file, where, and what is wrong.
- **finding**: A claim that survived confirmation (it was not refuted), with a score. Confirmed findings carry Opus's evidence.
- **confirmed**: Opus checked the claim against the code and said it holds.
- **refuted**: Opus checked the claim against the code and said it does not hold. Refuted claims are never shown.
- **ledger**: An append-only file of every review and every outcome, used to calibrate the ranking.
- **outcome**: The user's verdict on one finding after the fact: real bug or false alarm.

### How your outcomes change the ranking

**How does telling polywatch a finding was real or false change what it shows next time?**

The starting weights are guesses, and every codebase is different. polywatch gets better at a project only through the user saying which findings were worth their time.

The outcome goes into the ledger. The ranker reads the ledger on every review, so the next findings of that kind score higher or lower, and a kind that keeps being wrong drops below the threshold.

[Open the diagram](learn.architecture.html). 5 components.

| Component | Responsibility |
|---|---|
| **Claude Code** | Runs the coding turns and calls polywatch's hooks at each event. |
| **Findings skill** | Tells Claude how to present findings and record what the user says about them. |
| **polywatch CLI** | Lets a person read reports, review files by hand and record outcomes. |
| **Ledger** | Keeps every review and every recorded outcome, in order, for calibration. |
| **Ranker** | Scores each finding by how often findings of its kind turned out real. |

**Deliberately not shown.** The model providers, which the learning loop never touches.

#### The long read

The loop starts with the user. After seeing a finding, they tell Claude it was a real bug or a false alarm. The findings skill tells Claude to record it by running the CLI's outcome command, with the review id and the finding's number.

The CLI appends one line to the ledger. Nothing else changes at that moment.

The next time a review runs, the ranker reads the whole ledger. For each kind of finding (confirmed or not, high, medium or low severity) it counts the outcomes and computes a precision: the starting guess counts as four outcomes, and each recorded real or false moves the estimate. Findings are sorted by that precision, and only the top two above 0.25 are shown. A kind that has been wrong often enough falls below the line and is hidden; a kind that has been right rises.

#### Terms used here

- **turn**: One round of Claude Code work: the user's prompt and everything Claude does in answer, up to when it stops.
- **hook**: A command Claude Code runs at a fixed event, such as after a file edit, when a turn stops, or when the user submits a prompt.
- **tier**: polywatch's label for how hard a change is to get right, from its size and whether it touches concurrency, state or protocol logic.
- **finding**: A claim that survived confirmation (it was not refuted), with a score. Confirmed findings carry Opus's evidence.
- **confirmed**: Opus checked the claim against the code and said it holds.
- **precision**: The share of findings of one kind that turned out to be real bugs, as estimated from recorded outcomes.
- **ledger**: An append-only file of every review and every outcome, used to calibrate the ranking.
- **outcome**: The user's verdict on one finding after the fact: real bug or false alarm.

### Measuring on real project history

**How do we check polywatch against bugs a project actually had?**

A reviewer that sounds convincing can still be useless. The first test is a project's own history, where later fixes show which commits were wrong.

The git replay labels each commit buggy if a later fix commit changed its lines, runs the same worker on it, and has Opus judge whether any finding names the bug that was fixed.

[Open the diagram](measure-git.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **Git replay** | Replays a repository's commits through the worker and scores findings against later fixes. |
| **Project history** | Supplies commits and the fix commits that later changed them. |
| **Review worker** | Runs one review pipeline per turn, from routing to ranked result. |
| **Claude Opus 5.5** | Decides whether one claimed defect holds against the cited code and the request. |

**Deliberately not shown.** The hooks and delivery, which the replay bypasses by calling the worker directly.

#### The long read

The git replay reads the project's history. For every commit whose subject starts with fix, it blames the lines the fix changed and marks the commits that wrote them as buggy (the SZZ method). Commits that no fix ever touched, and that are old enough, are marked clean.

Each sampled commit becomes a job for the same worker the plugin uses, so the replay measures the shipped pipeline.

After the run, Opus compares each buggy commit's findings with the fix diff and says whether any finding names the bug that was fixed. The answer key is noisy: an unfixed bug looks clean. On BaanBaan this replay showed that the reviewer's verdict carries no information, and that its specific claims sometimes do.

#### Terms used here

- **turn**: One round of Claude Code work: the user's prompt and everything Claude does in answer, up to when it stops.
- **hook**: A command Claude Code runs at a fixed event, such as after a file edit, when a turn stops, or when the user submits a prompt.
- **claim**: One specific, checkable statement a reviewer makes about a defect: which file, where, and what is wrong.
- **finding**: A claim that survived confirmation (it was not refuted), with a score. Confirmed findings carry Opus's evidence.
- **SZZ**: A method for finding the commit that introduced a bug: blame the lines a later fix commit changed.

### Measuring on planted bugs

**How do we check polywatch where the right answer is exact?**

Git history cannot say which commits are really correct. Specifications checked against traces of the real system can, and a planted bug says exactly what a good reviewer should find.

The sysmobench replay reviews specifications a model checker has verified, and copies with one bug planted. Opus is shown the planted diff and says whether a finding names it. The verified specs count the false alarms.

[Open the diagram](measure-sysmo.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **sysmobench replay** | Runs the worker on checker-labelled specifications and planted bugs. |
| **sysmobench** | Supplies specifications whose correctness a model checker has decided. |
| **Review worker** | Runs one review pipeline per turn, from routing to ranked result. |
| **Claude Opus 5.5** | Decides whether one claimed defect holds against the cited code and the request. |

**Deliberately not shown.** The hooks and delivery, which the replay bypasses by calling the worker directly.

#### The long read

The sysmobench replay reads the price-of-trust study's ledgers: which specifications passed the checker, and which verified ones had a bug planted in them by another model.

Each specification is reviewed as a new file named spec.js, with the study's task prompt (which contains the real source code) as the request. Nothing in the file or its name says whether a bug was planted.

After the run, Opus is shown the diff between each mutant and its source and says whether any finding names the planted change. The verified originals give a clean count of false alarms, because the checker has already said they are correct. On the spinlock and lock service, 90 of 91 planted bugs were confirmed and ranked first, and 1 of 158 verified specs got a confirmed finding.

#### Terms used here

- **turn**: One round of Claude Code work: the user's prompt and everything Claude does in answer, up to when it stops.
- **hook**: A command Claude Code runs at a fixed event, such as after a file edit, when a turn stops, or when the user submits a prompt.
- **claim**: One specific, checkable statement a reviewer makes about a defect: which file, where, and what is wrong.
- **finding**: A claim that survived confirmation (it was not refuted), with a score. Confirmed findings carry Opus's evidence.
- **confirmed**: Opus checked the claim against the code and said it holds.
- **ledger**: An append-only file of every review and every outcome, used to calibrate the ranking.
- **mutant**: A copy of a correct specification with one small behavioral bug introduced on purpose, so the answer is known.
- **sysmobench**: A benchmark of executable specifications of real systems, checked by replaying traces recorded from the real implementation.

## Boundaries

A boundary is a claim about everything inside it.

### Your machine

*trust boundary.* Runs on the developer's machine; code leaves it only in the two model calls

Contains: Hook entry, Turn log and jobs, Settings, Review worker, Router, Project tests, Ranker, Review results, Ledger, Delivery, polywatch CLI, Findings skill, Git replay, sysmobench replay.

Crossed by:

- **Review worker → DeepSeek Flash** over https. Contents of changed files (excluded files never sent) and the request text; back comes JSON with issues, each with file, place, severity and claim.
- **Review worker → Claude Opus 5.5** over https. One claim, the cited code or windows around it, and the request when short; back comes holds yes, no or uncertain with evidence.
- **Git replay → Claude Opus 5.5** over https. Reviewer issues and the later fix diff; back comes which issue, if any, is the fixed bug.
- **sysmobench replay → Claude Opus 5.5** over https. The planted diff and the reviewer's issues; back comes which issue, if any, names the planted bug.

## Components

**Claude Code**: Runs the coding turns and calls polywatch's hooks at each event.

**Hook entry**: Handles each hook event in under a second and returns control to Claude Code.

- Source: `hooks/hooks.json`, `bin/polywatch.mjs`

**Turn log and jobs**: Holds the edits of the current turn and the job the worker will review.

- Source: `bin/polywatch.mjs`

**Settings**: Supplies models, budgets, exclusions and ranking thresholds, merged over defaults.

- Source: `src/config.mjs`

**Review worker**: Runs one review pipeline per turn, from routing to ranked result.

- Source: `src/worker.mjs`

**Router**: Labels a change EASY, MEDIUM or HARD from its size and the kind of code it touches.

- Source: `src/router.mjs`

**DeepSeek Flash**: Lists specific, checkable defects in the changed files.

- Source: `src/reviewers/deepseek.mjs`, `src/prompts.mjs`

**Claude Opus 5.5**: Decides whether one claimed defect holds against the cited code and the request.

- Source: `src/reviewers/anthropic.mjs`, `src/prompts.mjs`

**Project tests**: Runs the project's own test command on hard changes when one is configured.

- Source: `src/worker.mjs`

**Ranker**: Scores each finding by how often findings of its kind turned out real.

- Source: `src/rank.mjs`

**Review results**: Holds one result per reviewed turn until it is delivered.

- Source: `src/worker.mjs`

**Ledger**: Keeps every review and every recorded outcome, in order, for calibration.

- Source: `src/worker.mjs`, `src/rank.mjs`

**Delivery**: Decides what the user sees and what goes back to Claude.

- Source: `src/deliver.mjs`

**polywatch CLI**: Lets a person read reports, review files by hand and record outcomes.

- Source: `bin/polywatch.mjs`

**Findings skill**: Tells Claude how to present findings and record what the user says about them.

- Source: `skills/trust/SKILL.md`

**Git replay**: Replays a repository's commits through the worker and scores findings against later fixes.

- Source: `scripts/replay-git.mjs`

**sysmobench replay**: Runs the worker on checker-labelled specifications and planted bugs.

- Source: `scripts/replay-sysmo.mjs`

**Project history**: Supplies commits and the fix commits that later changed them.

**sysmobench**: Supplies specifications whose correctness a model checker has decided.

## What moves between them

| From | To | Mechanism | What crosses |
|---|---|---|---|
| Claude Code | Hook entry | spawn | Hook JSON on stdin: the tool, file path, old and new text, session id and transcript path. |
| Hook entry | Turn log and jobs | file | Each Edit, Write or MultiEdit of the turn; at Stop, a job with the edits and the last user request. |
| Hook entry | Review worker | spawn | The job file path. The Stop hook returns at once; Claude never waits on the review. |
| Hook entry | Claude Code | stdio | systemMessage for the user (top findings or 'nothing worth your attention'); additionalContext for Claude with confirmed findings only. |
| Hook entry | Delivery | in-process call | The session id and settings, at UserPromptSubmit and SessionStart. |
| Review worker | Turn log and jobs | file | Edits, file snapshots and the request text. |
| Review worker | Settings | in-process call | Models, keys' environment names, budget, exclusions, confirm mode, thresholds. |
| Review worker | Router | in-process call | Changed lines and file text in; a tier and its reason out. |
| Review worker | DeepSeek Flash | https | Contents of changed files (excluded files never sent) and the request text; back comes JSON with issues, each with file, place, severity and claim. *(crosses Your machine)* |
| Review worker | Project tests | spawn | The test command, on HARD changes only; exit status and output tail back. |
| Review worker | Claude Opus 5.5 | https | One claim, the cited code or windows around it, and the request when short; back comes holds yes, no or uncertain with evidence. *(crosses Your machine)* |
| Review worker | Ranker | in-process call | Findings that survived confirmation; back comes each with a score, best first. |
| Ranker | Ledger | file | Past findings and the real or false outcomes recorded for them. |
| Review worker | Review results | file | Tier, findings, the top ones shown, confirmed issues, refuted count, cost and notes. |
| Review worker | Ledger | file | The same result, kept after delivery for calibration. |
| Delivery | Review results | file | Results for this session not yet shown; marked delivered afterwards. |
| polywatch CLI | Ledger | file | Review id, finding number and real or false. |
| polywatch CLI | Review results | file | Recent results with findings and evidence. |
| Claude Code | Findings skill | manual | The user's question about findings or an outcome to record. |
| Findings skill | polywatch CLI | spawn | The report command, or an outcome for one finding. |
| Git replay | Project history | spawn | Commit diffs, file versions and the lines each fix changed. |
| Git replay | Review worker | in-process call | A job built from one commit's diff and message. |
| Git replay | Claude Opus 5.5 | https | Reviewer issues and the later fix diff; back comes which issue, if any, is the fixed bug. *(crosses Your machine)* |
| sysmobench replay | sysmobench | file | Spec files, mutant files, their source specs and the checker's verdicts. |
| sysmobench replay | Review worker | in-process call | A job that writes the spec as spec.js, with the study's task prompt as the request. |
| sysmobench replay | Claude Opus 5.5 | https | The planted diff and the reviewer's issues; back comes which issue, if any, names the planted bug. *(crosses Your machine)* |

## Doctrines, guarantees and trade-offs

### Doctrines

- **The reviewer's overall verdict is ignored** on 50 BaanBaan commits it rejected 24 of 25 later-fixed and 25 of 25 clean ones; a score built on it separated them no better than chance (AUC 0.48)
- **Recorded outcomes set the ranking** each kind of finding starts from a prior precision worth four outcomes; every real or false the user records moves it

### Guarantees

- **Claude never waits for a review** the Stop hook starts a detached worker and returns; results arrive on the next prompt
- **A claim Opus refutes is never shown** refuted claims are removed before ranking
- **Only confirmed findings go back to Claude, at most two turns in a row** an unconfirmed claim sent as an instruction would have Claude fix code that may be correct, and a cap stops fix loops
- **Excluded files never leave the machine** .env, keys, *secret*, *credential* and node_modules are dropped before the reviewer prompt is built
- **On sysmobench, 104 of 106 planted bugs the checker catches were confirmed and ranked first** the answer key is the planted diff; on small systems 1 of 158 correct specs got a confirmed finding, on etcd 4 of 15 with the request

### Constraints

- **At most two findings are shown per turn, and only above a score of 0.25** the reviewer lists about three issues per change; most are not worth a person's attention
- **Spend stops at $0.50 per turn** the worker checks cost before each confirmation
- **Only the worker calls the reviewer model**

### Trade-offs

- **Opus sees the request only when it is short** on sysmobench etcd the request removed 11 of 15 false alarms, but a 90 KB request made each check cost about $0.16; the default includes requests up to 20,000 characters

### Risks

- **Git history is a noisy answer key** 'clean' only means no fix commit touched the lines; some confirmed findings on clean commits may be real bugs nobody fixed

