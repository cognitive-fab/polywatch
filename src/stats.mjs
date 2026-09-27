// How polywatch has done in one project: cost, what it found, what reached Claude, what was recorded.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listJson, readJson } from './util.mjs';
import { calibration } from './rank.mjs';

const HOUR = 3600e3;
export const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Other .polywatch folders below the project: state that older versions left in subfolders.
function strayStateDirs(root, d = root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(d, e.name);
    if (e.name === '.polywatch') { if (d !== root) out.push(relative(root, p)); continue; }
    strayStateDirs(root, p, depth + 1, out);
  }
  return out;
}

// strays: walk the project for old .polywatch folders (slow on big trees; the dashboard skips it).
export function stats(root, now = Date.now(), { strays = true } = {}) {
  const dir = join(root, '.polywatch');
  const results = listJson(join(dir, 'results')).map(p => readJson(p)).filter(Boolean);
  const ledger = readJsonl(join(dir, 'ledger.jsonl'));
  const reviewed = results.filter(r => !r.skipped && !r.reviewer?.error);
  const adj = reviewed.flatMap(r => r.adjudications || []);
  const count = (xs, f) => xs.filter(f).length;
  const outcomes = ledger.filter(l => l.kind === 'finding-outcome');
  const old = (p) => { try { return now - statSync(p).mtimeMs > HOUR; } catch { return false; } };
  const turnsDir = join(dir, 'turns');
  const pendingTurns = existsSync(turnsDir) ? readdirSync(turnsDir).flatMap(s => listJson(join(turnsDir, s))) : [];
  return {
    root,
    reviews: results.length,
    sessions: new Set(results.map(r => r.session)).size,
    skipped: count(results, r => r.skipped),
    reviewerErrors: count(results, r => r.reviewer?.error),
    tiers: reviewed.reduce((m, r) => ({ ...m, [r.tier]: (m[r.tier] || 0) + 1 }), {}),
    cost: {
      total: results.reduce((s, r) => s + (r.cost || 0), 0),
      reviewer: results.reduce((s, r) => s + (r.reviewer?.usd || 0), 0),
      adjudicator: adj.reduce((s, a) => s + (a.usd || 0), 0),
    },
    reviewerSeconds: { median: median(reviewed.map(r => r.reviewer?.seconds || 0)), max: Math.max(0, ...reviewed.map(r => r.reviewer?.seconds || 0)) },
    candidates: reviewed.reduce((s, r) => s + (r.reviewer?.issues?.length || 0), 0),
    checked: { total: adj.length, confirmed: count(adj, a => a.holds === 'yes'), refuted: count(adj, a => a.holds === 'no'), uncertain: count(adj, a => a.holds === 'uncertain'), error: count(adj, a => a.holds === 'error') },
    shown: reviewed.reduce((s, r) => s + (r.shown?.length || 0), 0),
    sentToClaude: reviewed.filter(r => r.sentToClaude === true).reduce((s, r) => s + (r.issues?.length || 0), 0),
    withheld: reviewed.filter(r => r.sentToClaude === false).reduce((s, r) => s + (r.issues?.length || 0), 0),
    // Results delivered before 0.2.1 did not record whether maxFixRounds held them back.
    sentUnknown: reviewed.filter(r => r.delivered && r.sentToClaude === undefined).reduce((s, r) => s + (r.issues?.length || 0), 0),
    undelivered: count(results, r => !r.delivered && r.session !== 'manual'),
    outcomes: { real: count(outcomes, o => o.verdict === 'real'), false: count(outcomes, o => o.verdict !== 'real') },
    precision: calibration(dir),
    problems: {
      strayStateDirs: strays ? strayStateDirs(root) : [],
      strandedTurnFiles: pendingTurns.filter(old).length,
      stuckJobs: listJson(join(dir, 'jobs')).filter(old).length,
      errors: readJsonl(join(dir, 'errors.jsonl')).length,
    },
  };
}

export function renderStats(s) {
  const $ = (x) => `$${x.toFixed(2)}`;
  const c = s.checked, p = s.problems;
  const lines = [
    `polywatch stats for ${s.root}`,
    `reviews        ${s.reviews} in ${s.sessions} session(s): ${s.reviews - s.skipped - s.reviewerErrors} reviewed, ${s.skipped} skipped, ${s.reviewerErrors} reviewer errors`,
    `tiers          ${Object.entries(s.tiers).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
    `cost           ${$(s.cost.total)} (reviewer ${$(s.cost.reviewer)}, adjudicator ${$(s.cost.adjudicator)})${s.reviews ? `, ${$(s.cost.total / s.reviews)} per review` : ''}`,
    `reviewer time  median ${Math.round(s.reviewerSeconds.median)} s, max ${Math.round(s.reviewerSeconds.max)} s`,
    `candidates     ${s.candidates} raised by the reviewer`,
    `checked        ${c.total}: ${c.confirmed} confirmed, ${c.refuted} refuted, ${c.uncertain} uncertain${c.error ? `, ${c.error} failed` : ''}`,
    `shown to you   ${s.shown} finding(s)`,
    `sent to Claude ${s.sentToClaude} confirmed finding(s)${s.withheld ? `; ${s.withheld} withheld by maxFixRounds` : ''}${s.sentUnknown ? `; ${s.sentUnknown} from older reviews that may or may not have been sent` : ''}${s.undelivered ? `; ${s.undelivered} review(s) not delivered yet` : ''}`,
    `outcomes       ${s.outcomes.real} real, ${s.outcomes.false} false alarm(s) recorded`,
    `precision      ${Object.entries(s.precision).filter(([, v]) => v.outcomes).map(([b, v]) => `${b} ${Math.round(v.precision * 100)}% (${v.outcomes})`).join(', ') || 'priors only: record outcomes with polywatch outcome <id> <n> real|false'}`,
  ];
  const warn = [];
  if (p.strayStateDirs.length) warn.push(`state in subfolders (from polywatch before 0.2.1): ${p.strayStateDirs.join(', ')}`);
  if (p.strandedTurnFiles) warn.push(`${p.strandedTurnFiles} edit record(s) older than an hour were never reviewed`);
  if (p.stuckJobs) warn.push(`${p.stuckJobs} job(s) older than an hour never finished`);
  if (p.errors) warn.push(`${p.errors} error(s) in .polywatch/errors.jsonl`);
  return [...lines, ...(warn.length ? ['problems', ...warn.map(w => `  - ${w}`)] : [])].join('\n');
}
