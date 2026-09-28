// Deterministic router: no model. Places a change on the study's difficulty scale.
// Word boundaries sit only next to word characters: a trailing \b after "(" or "{" would require a
// word character to follow, so `lock()` or `select {` would never count.
const CONCURRENCY = /\b(?:mutex|synchronized|atomic|goroutine|await|async|thread|Worker|semaphore|setTimeout|setInterval|queue|race)\b|\b(?:lock|unlock)\s*\(|\bgo\s+func\b|\bchan\s|\bselect\s*\{|\bPromise\.(?:all|race|any)\b/gi;
const STATE = /\b(state|status|transition|reducer|dispatch|fsm|machine|phase|mode|switch\s*\(|case\s)/gi;
const PROTOCOL = /\b(raft|paxos|consensus|leader|follower|quorum|replica|term\b|epoch|retry|idempoten\w*|transaction|commit|rollback|two-phase|lease|heartbeat|election|snapshot|wal\b|exactly-once|at-least-once)/gi;

const count = (re, s) => (s.match(re) || []).length;
const nonEmpty = (s) => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);

// Lines added plus lines removed, so an edit that only deletes code (a removed guard) still counts.
function changedLines(e) {
  const after = nonEmpty(e.after);
  if (e.before == null) return after.length;
  const before = nonEmpty(e.before);
  const b = new Set(before), a = new Set(after);
  return after.filter(l => !b.has(l)).length + before.filter(l => !a.has(l)).length;
}

export function features(units) {
  let changed = 0, conc = 0, state = 0, proto = 0;
  for (const u of units) {
    const text = u.edits.map(e => e.after).join('\n');
    changed += u.edits.reduce((n, e) => n + changedLines(e), 0);
    conc += count(CONCURRENCY, text);
    state += count(STATE, text);
    proto += count(PROTOCOL, text);
  }
  return { files: units.length, changedLines: changed, concurrencyHits: conc, stateHits: state, protocolHits: proto };
}

export function route(f) {
  const concurrent = f.concurrencyHits >= 2;
  const stateful = f.stateHits >= 3;
  const protocol = f.protocolHits >= 2;
  const n = f.changedLines;
  if (protocol && (concurrent || n > 60)) return { tier: 'HARD', why: 'protocol logic with concurrency or a sizeable change (etcd-like)' };
  if (concurrent && stateful && n > 80) return { tier: 'HARD', why: 'large concurrent stateful change' };
  if (n > 400) return { tier: 'HARD', why: 'very large change' };
  if (protocol || concurrent || stateful || n > 120) return { tier: 'MEDIUM', why: protocol ? 'protocol logic' : concurrent ? 'concurrency' : stateful ? 'stateful code' : 'large change' };
  return { tier: 'EASY', why: 'small sequential change' };
}
