// Ranking findings by how often findings of the same kind turned out to be real.
// A finding's bucket is (status, severity). Each bucket starts from a prior precision and is
// updated from recorded outcomes (`polywatch outcome <reviewId> <n> real|false`) with a
// Beta(prior * K, (1 - prior) * K) prior, so a handful of outcomes already moves it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ASSUMPTIONS until outcomes exist. On BaanBaan history (50 commits) the reviewer raised about
// three issues per commit on buggy and clean commits alike, and one of them was the later-fixed
// bug in 7 of 25 buggy commits: unconfirmed issues are mostly noise, confirmed ones less so.
export const PRIOR_PRECISION = {
  'confirmed:high': 0.6, 'confirmed:medium': 0.5, 'confirmed:low': 0.3,
  'unconfirmed:high': 0.3, 'unconfirmed:medium': 0.2, 'unconfirmed:low': 0.1,
};
const K = 4;

export const bucketOf = (f) => `${f.status === 'confirmed' ? 'confirmed' : 'unconfirmed'}:${['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium'}`;

export function calibration(dir) {
  const counts = {};
  const p = join(dir, 'ledger.jsonl');
  if (existsSync(p)) {
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const reviews = new Map(lines.filter(l => l.kind === 'review').map(l => [l.id, l]));
    // One outcome per finding: a later verdict (a correction, or the user over Claude) replaces an earlier one.
    const latest = new Map(lines.filter(l => l.kind === 'finding-outcome').map(o => [`${o.id}#${o.index}`, o]));
    for (const o of latest.values()) {
      const f = reviews.get(o.id)?.findings?.[o.index - 1];
      if (!f) continue;
      const b = bucketOf(f);
      counts[b] ||= { real: 0, false: 0 };
      counts[b][o.verdict === 'real' ? 'real' : 'false']++;
    }
  }
  const table = {};
  for (const [b, prior] of Object.entries(PRIOR_PRECISION)) {
    const c = counts[b] || { real: 0, false: 0 };
    table[b] = { precision: (prior * K + c.real) / (K + c.real + c.false), outcomes: c.real + c.false };
  }
  return table;
}

export function rank(findings, table) {
  return findings
    .map(f => ({ ...f, score: table[bucketOf(f)].precision }))
    .sort((a, b) => b.score - a.score);
}
