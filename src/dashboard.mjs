// A one-file HTML dashboard of polywatch activity in a project: what is running, what waits on the
// user (with the default if they do nothing), the latest reviews, and anything stuck.
// Layout after an idea by @voxyz_ai: a dashboard beside every long task, refreshed on its own.
//
// The page is .polywatch/dashboard.html. It opens with a double-click (no server) and reloads itself
// every 10 seconds; polywatch rewrites it when a review starts or ends, when results are delivered and
// when an outcome is recorded, once the user has created it with `polywatch dashboard`.
import { existsSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { listJson, readJson } from './util.mjs';
import { stats, readJsonl } from './stats.mjs';
import { PRIOR_PRECISION } from './rank.mjs';

const HOUR = 3600e3;
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const rel = (root, f) => relative(root, f).split(sep).join('/');

export const dashboardPath = (root) => join(root, '.polywatch', 'dashboard.html');

export function dashboardData(root, cfg, now = Date.now()) {
  const dir = join(root, '.polywatch');
  const results = listJson(join(dir, 'results')).map(p => readJson(p)).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const ledger = readJsonl(join(dir, 'ledger.jsonl'));
  const outcomes = new Map(ledger.filter(l => l.kind === 'finding-outcome').map(o => [`${o.id}#${o.index}`, o]));
  const s = stats(root, now, { strays: false });

  // Now: reviews running, turns being recorded, results waiting for the next prompt.
  const running = listJson(join(dir, 'jobs')).map(p => {
    const j = readJson(p) || {};
    return { id: j.id || basename(p, '.json'), since: mtime(p), files: [...new Set((j.edits || []).map(e => rel(root, e.file)))].slice(0, 6), stuck: now - mtime(p) > HOUR };
  });
  const turnsDir = join(dir, 'turns');
  const recording = existsSync(turnsDir) ? readdirSync(turnsDir).map(sess => {
    const parts = listJson(join(turnsDir, sess));
    if (!parts.length) return null;
    const times = parts.map(mtime);
    return { session: sess.slice(0, 8), edits: parts.length, since: Math.min(...times), last: Math.max(...times), stuck: now - Math.max(...times) > HOUR };
  }).filter(Boolean) : [];
  const waiting = results.filter(r => !r.delivered && r.session !== 'manual').map(r => ({ id: r.id, at: Date.parse(r.createdAt), findings: (r.shown || []).length }));

  // Waiting on you: each question with what happens if nobody answers.
  // Unrated confirmed findings are one question with the most recent examples, not one question each:
  // on a busy project there are dozens, and a wall of them hides the rest.
  const questions = [], unrated = [];
  for (const r of results) {
    (r.findings || []).forEach((f, i) => {
      if (f.status === 'confirmed' && !outcomes.has(`${r.id}#${i + 1}`)) unrated.push({ at: Date.parse(r.createdAt), review: r.id, n: i + 1, severity: f.severity, file: f.file, where: f.where, claim: f.claim });
    });
  }
  if (unrated.length) questions.push({ kind: 'outcome', at: unrated[0].at, count: unrated.length, items: unrated.slice(0, 5),
    ask: `${unrated.length} confirmed finding${unrated.length > 1 ? 's have' : ' has'} no outcome yet. Were they real?`,
    fallback: `They stay unrated, and ranking keeps using the starting estimates (confirmed high ${Math.round(PRIOR_PRECISION['confirmed:high'] * 100)}%, medium ${Math.round(PRIOR_PRECISION['confirmed:medium'] * 100)}%).`,
    command: 'polywatch outcome <review id> <n> real|false, or ask Claude to record the ones it fixed' });
  const held = results.filter(r => r.sentToClaude === false && r.issues?.length);
  for (const r of held.slice(0, 5)) {
    questions.push({ kind: 'withheld', at: Date.parse(r.createdAt), review: r.id, claim: r.issues.map(i => i.claim).join(' / '),
      ask: `${r.issues.length} confirmed finding${r.issues.length > 1 ? 's were' : ' was'} held back from Claude after two fix rounds in a row. Send them?`,
      fallback: 'Not sent. Claude keeps working on your request; ask it to look at this review if you want them fixed.',
      command: `polywatch report, then give review ${r.id} to Claude` });
  }
  for (const w of cfg.warnings || []) questions.push({ kind: 'config', ask: w, fallback: 'The setting is ignored and polywatch runs with its defaults.', command: 'edit ~/.polywatch.json' });

  // Stuck: anything that stopped moving or failed.
  const stuck = [];
  for (const j of running.filter(j => j.stuck)) stuck.push({ what: `Review ${j.id} has not finished`, detail: 'The background worker probably died. The job file can be deleted; the next turn is reviewed normally.', since: j.since });
  for (const t of recording.filter(t => t.stuck)) stuck.push({ what: `${t.edits} edit record${t.edits > 1 ? 's' : ''} from session ${t.session} were never reviewed`, detail: 'The turn ended without a Stop hook (a killed session, or a crash).', since: t.last });
  for (const r of results.slice(0, 20).filter(r => r.reviewer?.error)) stuck.push({ what: `Reviewer unavailable for ${r.id}`, detail: r.reviewer.error, since: Date.parse(r.createdAt) });
  for (const r of results.slice(0, 20)) for (const n of r.notes || []) if (/unavailable|budget reached|No price known/i.test(n)) stuck.push({ what: `Review ${r.id}`, detail: n, since: Date.parse(r.createdAt) });
  for (const e of readJsonl(join(dir, 'errors.jsonl')).slice(-5)) stuck.push({ what: `polywatch error in ${e.cmd || 'a hook'}`, detail: String(e.error || '').split('\n')[0], since: Date.parse(e.at) });

  // Latest reviews.
  const recent = results.slice(0, 25).map(r => ({
    id: r.id, at: Date.parse(r.createdAt), files: (r.files || []).slice(0, 5), moreFiles: Math.max(0, (r.files || []).length - 5), tier: r.tier, cost: r.cost || 0,
    skipped: r.skipped || null, error: r.reviewer?.error || null, refuted: r.refuted || 0,
    confirmed: (r.findings || []).filter(f => f.status === 'confirmed').length, unconfirmed: (r.findings || []).filter(f => f.status !== 'confirmed').length,
    top: (r.shown || []).slice(0, 2).map(f => ({ status: f.status, severity: f.severity, file: f.file, where: f.where, claim: f.claim })),
    delivered: r.delivered ? Date.parse(r.delivered) : null, sent: r.sentToClaude ?? null,
  }));

  // Last 14 days, by local date.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 864e5); const key = d.toLocaleDateString('en-CA');
    const rs = results.filter(r => new Date(r.createdAt).toLocaleDateString('en-CA') === key);
    days.push({ day: key, reviews: rs.length, confirmed: rs.reduce((a, r) => a + (r.findings || []).filter(f => f.status === 'confirmed').length, 0), usd: rs.reduce((a, r) => a + (r.cost || 0), 0) });
  }
  const today = days.at(-1);

  return {
    generatedAt: now, project: basename(root), root,
    style: { theme: 'light', density: 'compact', accent: '#1D56C9', ...(cfg.dashboard || {}) },
    totals: { reviews: s.reviews, reviewed: s.reviews - s.skipped - s.reviewerErrors, confirmed: s.checked.confirmed, refuted: s.checked.refuted, sent: s.sentToClaude, withheld: s.withheld,
      real: s.outcomes.real, falseAlarms: s.outcomes.false, usd: s.cost.total, usdToday: today.usd, reviewsToday: today.reviews },
    running, recording, waiting, questions, questionCount: unrated.length + held.length + (cfg.warnings || []).length, stuck: stuck.slice(0, 12), recent, days,
  };
}

// JSON inside a <script> element: "<" is escaped so no data can close the element.
const embed = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

export function renderDashboard(data) {
  return TEMPLATE.replace('__DATA__', embed(data)).replace('__TITLE__', `polywatch · ${String(data.project).replace(/[<&>"]/g, '')}`);
}

export function writeDashboard(root, cfg) {
  const p = dashboardPath(root);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, renderDashboard(dashboardData(root, cfg)));
  renameSync(tmp, p);
  return p;
}

// Refresh an existing dashboard; never create one the user did not ask for. Errors never reach a hook.
export function refreshDashboard(root, cfg) {
  try { if (cfg.dashboard?.enabled !== false && existsSync(dashboardPath(root))) writeDashboard(root, cfg); } catch {}
}

export function openInBrowser(p) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', p]] : process.platform === 'darwin' ? ['open', [p]] : ['xdg-open', [p]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

const TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>__TITLE__</title>
<style>
:root{--ground:#F3F5F8;--paper:#FFFFFF;--ink:#121821;--muted:#586273;--rule:#DCE1E8;--accent:#1D56C9;--good:#16774A;--good-soft:#E6F4EC;--warn:#9A5B00;--warn-soft:#FBF1DF;--bad:#A8412C;--bad-soft:#F8E9E5;--chip:#EEF0F4;--gap:14px;--pad:14px;
--body:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;color-scheme:light}
:root[data-theme=dark]{--ground:#0F141A;--paper:#161D25;--ink:#E6EBF1;--muted:#98A3B3;--rule:#2A3440;--good:#4CC38A;--good-soft:#16302A;--warn:#E3A94A;--warn-soft:#33291A;--bad:#F08A73;--bad-soft:#3A2220;--chip:#222B36;color-scheme:dark}
:root[data-density=airy]{--gap:22px;--pad:20px}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.45 var(--body)}
.wrap{max-width:1280px;margin:0 auto;padding-inline:16px;padding-block:18px 32px;display:grid;gap:var(--gap)}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
h1{font-size:20px;margin:0;letter-spacing:-.01em}
h1 small{font:500 12px var(--mono);color:var(--muted);margin-left:8px}
.clock{font:12px var(--mono);color:var(--muted);text-align:right}
.clock b{color:var(--ink);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--gap)}
.kpi{background:var(--paper);border:1px solid var(--rule);border-radius:6px;padding:10px var(--pad)}
.kpi .v{font:700 22px/1.1 var(--body);font-variant-numeric:tabular-nums}
.kpi .l{font:12px var(--mono);color:var(--muted);margin-top:2px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap)}
@media (max-width:900px){.grid{grid-template-columns:1fr}}
section{background:var(--paper);border:1px solid var(--rule);border-radius:6px;padding:var(--pad);min-width:0}
section.wide{grid-column:1/-1}
h2{font:600 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px;display:flex;justify-content:space-between;gap:8px}
h2 .count{color:var(--ink)}
.item{border-top:1px solid var(--rule);padding:9px 0;display:grid;gap:3px}
.item:first-of-type{border-top:0;padding-top:0}
.row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.t{font:12px var(--mono);color:var(--muted);white-space:nowrap}
.claim{overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sub{border-left:2px solid var(--rule);padding-left:10px;display:grid;gap:2px;margin:4px 0}
.file{font:12px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.fallback{font-size:13px;color:var(--muted)}
.fallback b{color:var(--ink);font-weight:600}
code{font:12px var(--mono);background:var(--chip);padding:1px 5px;border-radius:3px;overflow-wrap:anywhere}
.pill{display:inline-block;font:600 11px/1.7 var(--mono);padding:0 7px;border-radius:3px;white-space:nowrap;background:var(--chip);color:var(--muted)}
.pill.good{background:var(--good-soft);color:var(--good)}.pill.warn{background:var(--warn-soft);color:var(--warn)}.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.acc{background:var(--chip);color:var(--accent)}
.empty{color:var(--muted);font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--accent);margin-right:6px;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
.chart{overflow-x:auto}
footer{font:12px var(--mono);color:var(--muted);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
footer a{color:var(--muted)}
</style></head>
<body><div class="wrap" id="app"></div>
<script id="data" type="application/json">__DATA__</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById('data').textContent);
  var S = D.style || {}; var root = document.documentElement;
  if (S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)) root.dataset.theme = 'dark';
  if (S.density === 'airy') root.dataset.density = 'airy';
  if (S.accent && /^#[0-9a-f]{3,8}$/i.test(S.accent)) root.style.setProperty('--accent', S.accent);
  var now = Date.now();
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return p; }
  function clock(ms) { return ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function ago(ms) { if (!ms) return ''; var s = Math.max(0, Math.round((now - ms) / 1000)); if (s < 60) return s + ' s ago'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; }
  function when(ms) { return el('span', 't', clock(ms) + ' · ' + ago(ms)); }
  function usd(x) { return '$' + (x || 0).toFixed(x >= 10 ? 0 : 2); }
  function pill(text, kind) { return el('span', 'pill' + (kind ? ' ' + kind : ''), text); }
  function panel(title, count, wide) { var s = el('section', wide ? 'wide' : ''); var h = el('h2'); add(h, el('span', '', title), count != null ? el('span', 'count', String(count)) : null); s.appendChild(h); return s; }
  function empty(p, text) { p.appendChild(el('div', 'empty', text)); }
  var app = document.getElementById('app'), T = D.totals;

  var head = el('header');
  add(head, add(el('h1', '', 'polywatch'), el('small', '', D.project)),
    add(el('div', 'clock'), add(el('div'), el('span', '', 'Updated '), el('b', '', clock(D.generatedAt)), el('span', '', ' · ' + ago(D.generatedAt))), el('div', '', 'Reloads every 10 s · now ' + new Date(now).toLocaleTimeString())));
  app.appendChild(head);

  var k = el('div', 'kpis');
  [[T.reviewed + ' / ' + T.reviews, 'turns reviewed'], [T.confirmed, 'confirmed by Opus'], [T.sent, 'sent to Claude' + (T.withheld ? ' (' + T.withheld + ' held back)' : '')],
   [T.real + ' / ' + T.falseAlarms, 'real / false alarm'], [usd(T.usd), 'review cost, ' + usd(T.usdToday) + ' today'], [D.questionCount, 'waiting on you']].forEach(function (x) {
    k.appendChild(add(el('div', 'kpi'), el('div', 'v', String(x[0])), el('div', 'l', x[1])));
  });
  app.appendChild(k);

  var grid = el('div', 'grid'); app.appendChild(grid);

  // Now
  var nowP = panel('Now', D.running.length + D.recording.length || null);
  D.running.forEach(function (j) {
    nowP.appendChild(add(el('div', 'item'), add(el('div', 'row'), j.stuck ? pill('stalled', 'bad') : add(el('span'), el('span', 'dot'), el('span', '', 'Reviewing')), el('span', 'file', j.id), when(j.since)),
      el('div', 'file', j.files.join(', '))));
  });
  D.recording.forEach(function (t) {
    nowP.appendChild(add(el('div', 'item'), add(el('div', 'row'), pill('recording', 'acc'), el('span', '', t.edits + ' edit' + (t.edits > 1 ? 's' : '') + ' in session ' + t.session), when(t.last)),
      el('div', 'fallback', 'Reviewed when this turn ends.')));
  });
  if (D.waiting.length) nowP.appendChild(add(el('div', 'item'), add(el('div', 'row'), pill('ready', 'good'), el('span', '', D.waiting.length + ' review' + (D.waiting.length > 1 ? 's' : '') + ' ready')),
    el('div', 'fallback', 'Shown in your session with your next prompt.')));
  if (!nowP.querySelector('.item')) empty(nowP, 'Nothing running. The next turn that changes code starts a review.');
  grid.appendChild(nowP);

  // Waiting on you
  var qP = panel('Waiting on you', D.questionCount);
  D.questions.forEach(function (q) {
    var it = el('div', 'item');
    var top = add(el('div', 'row'), pill(q.kind === 'outcome' ? 'outcome' : q.kind === 'withheld' ? 'held back' : 'config', q.kind === 'config' ? 'warn' : 'acc'));
    if (q.severity) top.appendChild(pill(q.severity, q.severity === 'high' ? 'bad' : 'warn'));
    if (q.at) top.appendChild(when(q.at));
    it.appendChild(top);
    it.appendChild(el('div', '', q.ask));
    if (q.claim) { var c = el('div', 'claim', q.claim); c.title = q.claim; it.appendChild(c); }
    (q.items || []).forEach(function (x) { var c = el('div', 'claim', x.claim); c.title = x.claim; it.appendChild(add(el('div', 'sub'), add(el('div', 'row'), x.severity ? pill(x.severity, x.severity === 'high' ? 'bad' : 'warn') : null, el('span', 'file', x.review + ' #' + x.n), when(x.at)), c, el('div', 'file', (x.file || '') + (x.where ? ' · ' + x.where : '')))); });
    if (q.count > (q.items || []).length && q.items) it.appendChild(el('div', 'empty', (q.count - q.items.length) + ' more in polywatch report.'));
    if (q.file) it.appendChild(el('div', 'file', q.file + (q.where ? ' · ' + q.where : '')));
    it.appendChild(add(el('div', 'fallback'), el('b', '', 'If you do nothing: '), el('span', '', q.fallback)));
    if (q.command) it.appendChild(add(el('div'), el('code', '', q.command)));
    qP.appendChild(it);
  });
  if (!D.questions.length) empty(qP, 'Nothing needs you.');
  grid.appendChild(qP);

  // Latest reviews
  var rP = panel('Latest reviews', D.recent.length, true);
  D.recent.forEach(function (r) {
    var it = el('div', 'item');
    var row = add(el('div', 'row'), when(r.at), el('span', 'file', r.id));
    if (r.skipped) row.appendChild(pill('skipped', ''));
    else if (r.error) row.appendChild(pill('reviewer error', 'bad'));
    else {
      row.appendChild(pill(r.tier || '?', ''));
      row.appendChild(pill(r.confirmed + ' confirmed', r.confirmed ? 'good' : ''));
      if (r.unconfirmed) row.appendChild(pill(r.unconfirmed + ' unconfirmed', ''));
      if (r.refuted) row.appendChild(pill(r.refuted + ' refuted', ''));
      row.appendChild(pill(r.sent === true ? 'sent to Claude' : r.sent === false ? 'held back' : r.delivered ? 'shown' : 'not shown yet', r.sent === false ? 'warn' : ''));
      row.appendChild(el('span', 't', usd(r.cost)));
    }
    it.appendChild(row);
    it.appendChild(el('div', 'file', r.files.join(', ') + (r.moreFiles ? ' +' + r.moreFiles + ' more' : '')));
    if (r.skipped) it.appendChild(el('div', 'fallback', r.skipped));
    if (r.error) it.appendChild(el('div', 'fallback', r.error));
    r.top.forEach(function (f) { it.appendChild(add(el('div', 'row'), pill(f.status, f.status === 'confirmed' ? 'good' : ''), el('span', 'claim', f.claim))); });
    rP.appendChild(it);
  });
  if (!D.recent.length) empty(rP, 'No reviews yet in this project.');

  // Stuck
  var sP = panel('Stuck', D.stuck.length);
  D.stuck.forEach(function (x) { sP.appendChild(add(el('div', 'item'), add(el('div', 'row'), pill('stuck', 'bad'), el('span', '', x.what), x.since ? when(x.since) : null), el('div', 'fallback', x.detail))); });
  if (!D.stuck.length) empty(sP, 'Nothing stuck.');
  grid.appendChild(sP);

  // Last 14 days
  var dP = panel('Last 14 days', null);
  var max = Math.max(1, Math.max.apply(null, D.days.map(function (d) { return d.reviews; })));
  var W = 560, H = 150, bw = W / D.days.length, ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 34)); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Reviews and confirmed findings per day');
  function sv(tag, attrs, text) { var e = document.createElementNS(ns, tag); for (var a in attrs) e.setAttribute(a, attrs[a]); if (text != null) e.textContent = text; svg.appendChild(e); return e; }
  sv('line', { x1: 0, x2: W, y1: H, y2: H, stroke: 'var(--rule)' });
  D.days.forEach(function (d, i) {
    var x = i * bw + bw * 0.18, w = bw * 0.64, h = d.reviews / max * (H - 18), hc = d.confirmed ? Math.min(h, d.confirmed / max * (H - 18)) : 0;
    if (d.reviews) sv('rect', { x: x, y: H - h, width: w, height: h, rx: 2, fill: 'var(--chip)', stroke: 'var(--rule)' });
    if (hc) sv('rect', { x: x, y: H - hc, width: w, height: hc, rx: 2, fill: 'var(--good)', opacity: 0.85 });
    if (d.reviews) sv('text', { x: x + w / 2, y: H - h - 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, String(d.reviews));
    if (i % 2 === 1 || i === D.days.length - 1) sv('text', { x: x + w / 2, y: H + 16, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--muted)' }, d.day.slice(5));
  });
  sv('text', { x: 0, y: H + 32, 'font-size': 11, fill: 'var(--muted)' }, 'bar: reviews per day · green: confirmed findings · cost this period ' + usd(D.days.reduce(function (a, d) { return a + d.usd; }, 0)));
  dP.appendChild(add(el('div', 'chart'), svg));
  grid.appendChild(dP);
  grid.appendChild(rP);

  app.appendChild(add(el('footer'), el('span', '', D.root), add(el('span'), el('span', '', 'Dashboard layout after an idea by '), add(el('a', '', '@voxyz_ai'), null))));
  var a = app.querySelector('footer a'); a.href = 'https://x.com/voxyz_ai'; a.target = '_blank'; a.rel = 'noopener';
})();
</script></body></html>`;
