# polywatch examples

Four small files, reviewed with `polywatch review`, DeepSeek V4.1-Flash as the reviewer and Claude Opus 5.5 confirming up to two claims per file (`.polywatch.json`). The files carry no comments pointing at a defect.

```bash
cd examples
node ../bin/polywatch.mjs review lock-bug.js --task "Model a two-thread spinlock: acquire and release"
node ../bin/polywatch.mjs review vote-bug.js --task "Implement Raft vote request handling like etcd raft.go"
```

## Results (v0.2, 2026-09-24)

| File | What is in it | Tier | Shown to you | Hidden / refuted | Cost |
|---|---|---|---|---|---|
| `lock-bug.js` | `release()` lets any thread release the lock | MEDIUM | 1 confirmed: the planted bug | 0 / 0 | $0.006 |
| `lock-fixed.js` | the same file with the holder check restored | MEDIUM | nothing worth your attention | 0 / 2 | $0.021 |
| `vote-bug.js` | vote rule ignores log terms; heartbeat handling stale | HARD | 2 confirmed: the planted bug and the stale heartbeat | 2 / 0 | $0.021 |
| `vote-partial-fix.js` | vote rule fixed; heartbeat handling still stale | HARD | 2 confirmed: both heartbeat defects | 1 / 0 | $0.038 |

### What each run shows

**`lock-bug.js`.** Opus confirms the reviewer's claim: `release()` "checks only `state.held` and ignores the `thread` parameter", so a non-holder can free the lock.

**`lock-fixed.js`: the false alarm is gone.** The reviewer still objects: `acquire` returns the unchanged state when the lock is held instead of spinning, and two calls could race. Opus refutes both, because this is "a pure state-transition model" where returning the state unchanged models a blocked step. In v0.1 the same objections produced a 17% trust score. One caveat: in an earlier run of v0.2 the reviewer raised a reentrancy question instead, and Opus confirmed it. Questions about intended behavior can survive confirmation when the task does not state the contract.

**`vote-bug.js`.** The planted bug (the up-to-date check "compares only lastIndex" and never the last log term) and a real departure from etcd raft.go that was not planted (a higher-term heartbeat never updates the node's term, role or vote) are both confirmed. Two weaker medium-severity claims are hidden.

**`vote-partial-fix.js`: fixing one bug does not make the file correct.** With the vote rule fixed, both remaining heartbeat defects are confirmed, with a concrete trace: after a term-5 heartbeat, a node still at term 1 grants a vote for term 3.

## Cost

Half a cent to a cent for the review, and about two cents per claim Opus checks.
