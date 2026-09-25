#!/usr/bin/env node
// Measure polywatch as a bug finder on sysmobench specifications, where correctness is decided mechanically.
//
//   node scripts/replay-sysmo.mjs build <sysmobenchDir> <outDir> <tasksDir> [--broken 20]
//   node scripts/replay-sysmo.mjs run   <outDir> [--concurrency 6] [--only mutant,verified]
//   node scripts/replay-sysmo.mjs judge <outDir>     (Opus: which reviewer issue, if any, names the planted bug?)
//   node scripts/replay-sysmo.mjs score <outDir>
//
// Item labels:
//   mutant         a verified spec with one planted behavioral bug that the checker catches (ground truth: the diff)
//   mutant-missed  a planted change the checker does NOT catch (possibly equivalent; reported separately)
//   verified       the source spec of a mutant: passes load, exploration, every trace window and every invariant
//   broken         a generated spec that fails the checker (etcd), for the rate of findings on known-wrong specs
// The reviewer sees each spec as a new file named spec.js, and the study's task prompt (with the real source) as the request.
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runJob } from '../src/worker.mjs';
import { callAnthropic } from '../src/reviewers/anthropic.mjs';
import { parseJson } from '../src/prompts.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];
const norm = (c) => String(c || '').trim().slice(0, 120);
const winPath = (p) => p.replace(/\\/g, '/');

function build(sysmo, out, tasksDir, nBroken) {
  const dir = join(sysmo, 'output', 'price_of_trust');
  const rows = readdirSync(dir).filter(f => /^ledger.*\.jsonl$/.test(f)).flatMap(f => readJsonl(join(dir, f)));
  const gens = new Map(rows.filter(r => r.kind === 'gen' && r.ok).map(r => [r.key, r]));
  const muts = new Map(); for (const r of rows.filter(r => r.kind === 'mutant' && r.changed)) muts.set(r.key, r);   // last record wins
  const items = [];
  const sources = new Set();
  for (const m of muts.values()) {
    const src = gens.get(m.src_key); if (!src) continue;
    items.push({ id: m.key.replace(/\|/g, '_'), label: m.keep ? 'mutant' : 'mutant-missed', task: m.task, model: m.model, spec: join(sysmo, winPath(m.spec_file)), source: join(sysmo, winPath(src.spec_file)) });
    sources.add(m.src_key);
  }
  for (const k of sources) { const g = gens.get(k); items.push({ id: k.replace(/\|/g, '_'), label: 'verified', task: g.task, model: g.model, spec: join(sysmo, winPath(g.spec_file)) }); }
  const broken = [...gens.values()].filter(g => g.task === 'etcd' && !g.verified && g.loadable !== false && g.spec_file);
  broken.sort((a, b) => a.key.localeCompare(b.key));
  const step = Math.max(1, Math.floor(broken.length / nBroken));
  for (let i = 0; i < broken.length && items.filter(x => x.label === 'broken').length < nBroken; i += step) {
    const g = broken[i]; items.push({ id: g.key.replace(/\|/g, '_'), label: 'broken', task: g.task, model: g.model, spec: join(sysmo, winPath(g.spec_file)) });
  }
  const ok = items.filter(it => existsSync(it.spec));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'dataset.json'), JSON.stringify({ sysmo, tasksDir, builtAt: new Date().toISOString(), items: ok }, null, 2));
  const count = {}; for (const it of ok) count[`${it.label}:${it.task}`] = (count[`${it.label}:${it.task}`] || 0) + 1;
  console.log(`items ${ok.length} (missing files ${items.length - ok.length})`, count);
}

async function run(out, conc, only, opt = {}) {
  const ds = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8'));
  const resPath = join(out, opt.resFile || 'results.jsonl');
  const done = new Set(readJsonl(resPath).map(r => r.id));
  const cached = opt.cachedFrom ? new Map(readJsonl(join(out, opt.cachedFrom)).map(r => [r.id, r.result?.reviewer])) : null;
  const state = join(out, opt.resFile ? `state-${opt.resFile.replace(/\.jsonl$/, '')}` : 'state'); mkdirSync(join(state, 'jobs'), { recursive: true });
  const tasks = {};
  const todo = ds.items.filter(it => !done.has(it.id) && (!only || only.includes(it.label)) && (!opt.task || it.task === opt.task) && (!cached || cached.get(it.id)?.issues));
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const it = todo[idx++];
      tasks[it.task] ??= readFileSync(join(ds.tasksDir, `${it.task}.txt`), 'utf8');
      const cwd = join(out, 'work', it.id); mkdirSync(cwd, { recursive: true });
      const file = join(cwd, 'spec.js'), content = readFileSync(it.spec, 'utf8');
      const jobPath = join(state, 'jobs', `${it.id}.json`);
      writeFileSync(jobPath, JSON.stringify({ id: it.id, session: 'sysmo', cwd, stateDir: state, configDir: out, task: tasks[it.task], edits: [{ file, tool: 'Write', before: null, after: content }], snapshots: { [file]: content } }));
      const rv = cached?.get(it.id);
      const deps = rv ? { review: async () => ({ text: JSON.stringify({ verdict: rv.verdict, confidence: rv.confidence, summary: rv.summary, issues: rv.issues || [] }), usd: 0, model: rv.model, finish: 'cached' }) } : {};
      let r; try { r = await runJob(jobPath, deps); } catch (e) { r = { error: String(e.message || e) }; }
      appendFileSync(resPath, JSON.stringify({ id: it.id, label: it.label, task: it.task, model: it.model, result: r }) + '\n');
      console.log(`${it.label.padEnd(13)} ${it.id.padEnd(28)} tier=${r.tier} issues=${r.reviewer?.issues?.length ?? r.reviewer?.error ?? '-'} shown=${r.shown?.length ?? '-'} confirmed=${r.issues?.length ?? '-'} refuted=${r.refuted ?? '-'} $${(r.cost || 0).toFixed(4)}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}

// Line diff (LCS) between the source spec and the mutant: the planted change.
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n'), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const outL = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { outL.push({ t: ' ', s: A[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { outL.push({ t: '+', s: B[j], b: j + 1 }); j++; }
    else { outL.push({ t: '-', s: A[i], a: i + 1 }); i++; }
  }
  const keep = new Set(); outL.forEach((l, k) => { if (l.t !== ' ') for (let d = -3; d <= 3; d++) keep.add(k + d); });
  const lines = []; let prev = -2;
  outL.forEach((l, k) => { if (!keep.has(k)) return; if (k !== prev + 1) lines.push(`@@ mutant line ${l.b ?? '?'} @@`); lines.push(`${l.t} ${l.s}`); prev = k; });
  return lines.join('\n');
}

async function judge(out) {
  const ds = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8'));
  const items = new Map(ds.items.map(it => [it.id, it]));
  const jPath = join(out, 'judgments.jsonl');
  const done = new Set(readJsonl(jPath).map(j => j.id));
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const rows = readJsonl(join(out, 'results.jsonl')).filter(r => r.label.startsWith('mutant') && !done.has(r.id) && r.result?.reviewer && !r.result.reviewer.error);
  for (const row of rows) {
    const it = items.get(row.id);
    const issues = row.result.reviewer.issues || [];
    const diff = lineDiff(readFileSync(it.source, 'utf8'), readFileSync(it.spec, 'utf8'));
    if (!issues.length) { appendFileSync(jPath, JSON.stringify({ id: row.id, match: 'no-issues', diff }) + '\n'); continue; }
    const prompt = `One behavioral bug was planted in a correct specification. The diff below shows the planted change ("-" original, "+" planted). A reviewer who did not see the diff then listed the issues below.

Decide whether ANY listed issue identifies the planted bug: it must point at the changed code (or its direct effect) and describe the wrong behavior the change causes. An issue about some other part of the file does not count, even if it is valid.

Reply with one JSON object: {"match": "yes" | "no", "issue_index": <number or null>, "why": "<one sentence>"}

===== PLANTED CHANGE =====
${diff}

===== REVIEWER ISSUES =====
${issues.map((x, i) => `${i}. ${x.where || ''}: ${x.claim}`).join('\n')}
`;
    const a = await callAnthropic({ model: 'claude-opus-5-5', apiKey: key, prompt, maxTokens: 2000 }).catch(e => ({ error: String(e.message || e) }));
    const j = a.error ? null : parseJson(a.text);
    appendFileSync(jPath, JSON.stringify({ id: row.id, match: j?.match || 'error', issue_index: j?.issue_index ?? null, claim: j?.issue_index != null ? issues[j.issue_index]?.claim : null, why: j?.why || a.error, diff, usd: a.usd || 0 }) + '\n');
    console.log(`${row.id} match=${j?.match || 'error'} ${String(j?.why || a.error).slice(0, 160)}`);
  }
}

function score(out, resFile = 'results.jsonl') {
  const rows = [...new Map(readJsonl(join(out, resFile)).filter(r => r.result && !r.result.error && r.result.reviewer && !r.result.reviewer.error).map(r => [r.id, r])).values()];
  const J = new Map(readJsonl(join(out, 'judgments.jsonl')).map(j => [j.id, j]));
  const has = (list, c) => c && (list || []).some(f => norm(f.claim) === norm(c));
  const by = (label, task) => rows.filter(r => r.label === label && (!task || r.task === task));
  const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : 'n/a';
  const avg = (rs, f) => rs.length ? (rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(2) : 'n/a';
  const tasks = ['spin', 'locksvc', 'etcd'];
  const recallRow = (name, f) => `| ${name} | ${tasks.map(t => { const M = by('mutant', t); return pct(M.filter(f).length, M.length); }).join(' | ')} | ${pct(by('mutant').filter(f).length, by('mutant').length)} |`;
  const bug = (r) => J.get(r.id)?.match === 'yes' ? J.get(r.id).claim : null;
  const noiseRow = (name, f) => `| ${name} | ${['mutant', 'verified', 'broken'].map(l => avg(by(l), f)).join(' | ')} |`;
  const anyRow = (name, f) => `| ${name} | ${['mutant', 'verified', 'broken'].map(l => pct(by(l).filter(f).length, by(l).length)).join(' | ')} |`;
  const missed = by('mutant-missed');
  const cost = rows.reduce((s, r) => s + (r.result.cost || 0), 0), jcost = [...J.values()].reduce((s, j) => s + (j.usd || 0), 0);
  const md = [
    `# polywatch on sysmobench specifications: ${rows.length} reviews`, '',
    '## Recall on planted bugs the checker catches', '',
    `| planted bug ... | spin | locksvc | etcd | all |`, `|---|---|---|---|---|`,
    recallRow('listed by the reviewer (any issue)', r => !!bug(r)),
    recallRow('kept after Opus confirmation (not refuted)', r => has(r.result.findings, bug(r))),
    recallRow('shown to the user (top 2)', r => has(r.result.shown, bug(r))),
    recallRow('confirmed and sent to Claude', r => has(r.result.issues, bug(r))),
    recallRow('ranked first', r => bug(r) && norm(r.result.shown?.[0]?.claim) === norm(bug(r))), '',
    '## What the user sees per spec', '',
    `| per spec | mutant | verified (checker-clean) | broken (etcd, checker-failed) |`, `|---|---|---|---|`,
    noiseRow('raw reviewer issues', r => r.result.reviewer.issues?.length || 0),
    noiseRow('findings shown', r => r.result.shown.length),
    noiseRow('confirmed findings sent to Claude', r => r.result.issues.length),
    anyRow('specs with a confirmed finding', r => r.result.issues.length > 0),
    anyRow('specs with "nothing worth your attention"', r => !r.result.shown.length), '',
    '## Specs with at least one confirmed finding, by system', '',
    `| system | mutant | verified | broken |`, `|---|---|---|---|`,
    ...tasks.map(t => `| ${t} | ${['mutant', 'verified', 'broken'].map(l => { const R = by(l, t); return pct(R.filter(r => r.result.issues.length > 0).length, R.length); }).join(' | ')} |`), '',
    `Confirmed findings on verified specs (upper bound on false alarms): ${by('verified').reduce((s, r) => s + r.result.issues.length, 0)} across ${by('verified').length} specs.`,
    `On mutants, confirmed findings that are NOT the planted bug: ${by('mutant').reduce((s, r) => s + r.result.issues.filter(f => norm(f.claim) !== norm(bug(r))).length, 0)} across ${by('mutant').length} specs.`,
    `Planted changes the checker missed: ${missed.length}; reviewer listed the change in ${missed.filter(r => !!bug(r)).length}, confirmed in ${missed.filter(r => has(r.result.issues, bug(r))).length}.`, '',
    `Cost: polywatch $${cost.toFixed(2)} (${rows.length} reviews), judge $${jcost.toFixed(2)}.`,
  ].join('\n');
  writeFileSync(join(out, resFile === 'results.jsonl' ? 'summary.md' : `summary-${resFile.replace(/\.jsonl$/, '')}.md`), md + '\n');
  console.log(md);
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd === 'build') build(a1, a2, a3, +arg('--broken', 20));
else if (cmd === 'run') await run(a1, +arg('--concurrency', 6), arg('--only', null)?.split(','), { cachedFrom: arg('--cached-from', null), resFile: arg('--out-file', null), task: arg('--task', null) });
else if (cmd === 'judge') await judge(a1);
else if (cmd === 'score') score(a1, arg('--file', 'results.jsonl'));
else console.log('usage: build <sysmobenchDir> <out> <tasksDir> | run <out> [--only labels] | judge <out> | score <out>');
