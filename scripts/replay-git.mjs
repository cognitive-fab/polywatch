#!/usr/bin/env node
// Replay a repository's history through polywatch and measure it against what actually happened.
//
//   node scripts/replay-git.mjs build <repo> <outDir> [--n 25] [--seed 1]
//   node scripts/replay-git.mjs run   <outDir> [--concurrency 6]
//   node scripts/replay-git.mjs judge <outDir>     (Opus: did a flagged issue match the real bug?)
//   node scripts/replay-git.mjs score <outDir>
//   node scripts/replay-git.mjs rerank <outDir>    (current ranking on the cached Flash reviews)
//   node scripts/replay-git.mjs score2 <outDir>
//
// Ground truth (SZZ): a commit is BUGGY if lines it wrote were later deleted or changed by a
// commit whose subject starts with "fix". It is CLEAN if it is not a fix, is older than the most
// recent 30 commits, and none of its lines were later blamed by a fix.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runJob } from '../plugin/src/worker.mjs';
import { callAnthropic } from '../plugin/src/reviewers/anthropic.mjs';
import { parseJson } from '../plugin/src/prompts.mjs';

const SRC = /\.(ts|tsx|js|mjs|cjs)$/i;
const SKIP = /(^|\/)(test|tests|__tests__|docs?|node_modules|dist|build|vendor|fixtures?)\//i;
const isSrc = (f) => SRC.test(f) && !SKIP.test(f) && !/\.(test|spec)\./i.test(f) && !/\.d\.ts$/i.test(f);
const git = (repo, args, max = 64 * 1024 * 1024) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: max });
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function shuffle(a, r) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function commitInfo(repo, sha) {
  const files = git(repo, ['diff-tree', '--no-commit-id', '-r', '--numstat', sha]).trim().split('\n').filter(Boolean)
    .map(l => { const [a, d, f] = l.split('\t'); return { f, a: +a || 0, d: +d || 0 }; }).filter(x => isSrc(x.f));
  return { files: files.map(x => x.f), changed: files.reduce((s, x) => s + x.a + x.d, 0) };
}

function build(repo, out, n, seed) {
  repo = resolve(repo);
  const log = git(repo, ['log', '--no-merges', '--format=%H%x09%s']).trim().split('\n').map(l => { const [h, s] = l.split('\t'); return { h, s }; });
  const order = new Map(log.map((c, i) => [c.h, i]));           // 0 = newest
  const isFix = (s) => /^fix(\(|:|!)/i.test(s);
  const blamed = new Map();                                        // bic -> [{fix, subject, file}]
  for (const fx of log.filter(c => isFix(c.s))) {
    let diff; try { diff = git(repo, ['diff', '-U0', `${fx.h}^`, fx.h]); } catch { continue; }
    let file = null;
    for (const line of diff.split('\n')) {
      if (line.startsWith('--- a/')) { file = line.slice(6); continue; }
      if (line.startsWith('--- ')) { file = null; continue; }
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+/);
      if (!m || !file || !isSrc(file)) continue;
      const start = +m[1], len = m[2] === undefined ? 1 : +m[2];
      if (len === 0 || len > 60) continue;                         // pure additions carry no blame; huge hunks are rewrites
      let bl; try { bl = git(repo, ['blame', '-w', '--porcelain', '-L', `${start},+${len}`, `${fx.h}^`, '--', file]); } catch { continue; }
      for (const b of bl.split('\n')) {
        const h = b.match(/^([0-9a-f]{40}) \d+ \d+/)?.[1];
        if (!h || h === fx.h || !order.has(h)) continue;
        if (!blamed.has(h)) blamed.set(h, []);
        const list = blamed.get(h);
        if (!list.some(x => x.fix === fx.h && x.file === file)) list.push({ fix: fx.h, subject: fx.s, file });
      }
    }
  }
  const eligible = (c) => { const i = commitInfo(repo, c.h); return i.files.length > 0 && i.files.length <= 8 && i.changed >= 10 && i.changed <= 400 ? i : null; };
  const r = rng(seed);
  const pos = [], neg = [];
  for (const c of shuffle(log.filter(c => blamed.has(c.h)), r)) { if (pos.length >= n) break; const i = eligible(c); if (i) pos.push({ ...c, ...i, label: 'buggy', fixes: blamed.get(c.h) }); }
  for (const c of shuffle(log.filter(c => !blamed.has(c.h) && !isFix(c.s) && order.get(c.h) >= 30), r)) { if (neg.length >= n) break; const i = eligible(c); if (i) neg.push({ ...c, ...i, label: 'clean' }); }
  mkdirSync(out, { recursive: true });
  const ds = { repo, builtAt: new Date().toISOString(), seed, fixCommits: log.filter(c => isFix(c.s)).length, totalCommits: log.length, bicTotal: blamed.size, items: [...pos, ...neg] };
  writeFileSync(join(out, 'dataset.json'), JSON.stringify(ds, null, 2));
  console.log(`commits ${log.length}, fix commits ${ds.fixCommits}, bug-introducing ${blamed.size}; sampled ${pos.length} buggy + ${neg.length} clean`);
}

function hunksToEdits(diff) {
  const edits = []; let cur = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { if (cur) edits.push(cur); cur = { before: [], after: [] }; continue; }
    if (!cur || line.startsWith('\\')) continue;
    if (line.startsWith('+')) cur.after.push(line.slice(1));
    else if (line.startsWith('-')) cur.before.push(line.slice(1));
    else if (line.startsWith(' ')) { cur.before.push(line.slice(1)); cur.after.push(line.slice(1)); }
  }
  if (cur) edits.push(cur);
  return edits.map(e => ({ before: e.before.join('\n'), after: e.after.join('\n') }));
}

function makeJob(ds, it, state, out, suffix = '') {
  const repo = ds.repo, edits = [], snapshots = {};
  for (const f of it.files) {
    const abs = join(repo, f);
    let content; try { content = git(repo, ['show', `${it.h}:${f}`]); } catch { continue; }   // deleted in this commit
    snapshots[abs] = content;
    const d = git(repo, ['diff', '-U3', `${it.h}^`, it.h, '--', f]);
    for (const e of hunksToEdits(d)) edits.push({ file: abs, tool: 'Edit', before: e.before || null, after: e.after });
  }
  const msg = git(repo, ['log', '-1', '--format=%B', it.h]).trim().slice(0, 3000);
  const jobPath = join(state, 'jobs', `${it.h.slice(0, 12)}${suffix}.json`);
  writeFileSync(jobPath, JSON.stringify({ id: it.h.slice(0, 12) + suffix, session: 'replay', cwd: repo, stateDir: state, configDir: out, task: msg, edits, snapshots }));
  return jobPath;
}

async function run(out, conc) {
  const ds = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8'));
  const resPath = join(out, 'results.jsonl');
  const done = new Set(existsSync(resPath) ? readFileSync(resPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).h) : []);
  const state = join(out, 'state'); mkdirSync(join(state, 'jobs'), { recursive: true });
  const todo = ds.items.filter(it => !done.has(it.h));
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const it = todo[idx++];
      const jobPath = makeJob(ds, it, state, out);
      let r; try { r = await runJob(jobPath); } catch (e) { r = { error: String(e.message || e) }; }
      appendFileSync(resPath, JSON.stringify({ h: it.h, label: it.label, subject: it.s, changed: it.changed, files: it.files, fixes: it.fixes, result: r }) + '\n');
      console.log(`${it.label.padEnd(5)} ${it.h.slice(0, 8)} tier=${r.tier} verdict=${r.reviewer?.verdict || r.reviewer?.error || '?'} shown=${r.shown?.length ?? '-'} $${(r.cost || 0).toFixed(4)}  ${it.s.slice(0, 60)}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}

async function judge(out) {
  // For buggy commits the reviewer rejected: did any reported issue describe the bug the later fix repaired?
  const ds = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8'));
  const rows = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const jPath = join(out, 'judgments.jsonl');
  const done = new Set(existsSync(jPath) ? readFileSync(jPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).h) : []);
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  for (const row of rows.filter(r => r.label === 'buggy' && !done.has(r.h))) {
    const issues = [...(row.result.reviewer?.issues || []), ...((row.result.adjudications || []).map(a => ({ ...a.claim, adjudicated: a.holds })))];
    if (!issues.length) { appendFileSync(jPath, JSON.stringify({ h: row.h, match: 'no-issues' }) + '\n'); continue; }
    const fixDiffs = [...new Set(row.fixes.map(f => f.fix))].slice(0, 3).map(fx => {
      const subj = git(ds.repo, ['log', '-1', '--format=%s', fx]).trim();
      const d = git(ds.repo, ['diff', '-U2', `${fx}^`, fx, '--', ...new Set(row.fixes.filter(f => f.fix === fx).map(f => f.file))]).slice(0, 12000);
      return `### Fix commit ${fx.slice(0, 8)}: ${subj}\n${d}`;
    }).join('\n\n');
    const prompt = `A code reviewer looked at a commit and reported the issues below. Later, the developers committed fixes that changed some of that commit's lines.\n\nDecide whether ANY reported issue describes the same defect that one of the fixes repaired (same code, same mistake). A different, unrelated issue does not count.\n\nReply with one JSON object: {"match": "yes" | "no", "issue_index": <number or null>, "why": "<one sentence>"}\n\n===== REPORTED ISSUES =====\n${issues.map((x, i) => `${i}. ${x.file} ${x.where || ''}: ${x.claim}`).join('\n')}\n\n===== LATER FIXES =====\n${fixDiffs}\n`;
    const a = await callAnthropic({ model: 'claude-opus-5-5', apiKey: key, prompt, maxTokens: 2000 }).catch(e => ({ error: String(e.message || e) }));
    const j = a.error ? null : parseJson(a.text);
    appendFileSync(jPath, JSON.stringify({ h: row.h, match: j?.match || 'error', issue_index: j?.issue_index ?? null, why: j?.why || a.error, usd: a.usd || 0 }) + '\n');
    console.log(`${row.h.slice(0, 8)} match=${j?.match || 'error'}  ${j?.why || a.error}`.slice(0, 220));
  }
}

function score(out) {
  const rows = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.result && !r.result.error && !r.result.skipped);
  const jPath = join(out, 'judgments.jsonl');
  const J = new Map(existsSync(jPath) ? readFileSync(jPath, 'utf8').trim().split('\n').filter(Boolean).map(l => { const j = JSON.parse(l); return [j.h, j]; }) : []);
  const rej = (r) => r.result.reviewer?.verdict === 'REJECT';
  const low = (r) => r.result.trust && r.result.trust.mean < 0.5;
  const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : 'n/a';
  const B = rows.filter(r => r.label === 'buggy'), C = rows.filter(r => r.label === 'clean');
  // AUC of (1 - trust) separating buggy from clean
  let auc = 0; for (const b of B) for (const c of C) auc += (b.result.trust.mean < c.result.trust.mean) ? 1 : (b.result.trust.mean === c.result.trust.mean ? 0.5 : 0);
  auc = B.length && C.length ? auc / (B.length * C.length) : NaN;
  const matched = B.filter(r => J.get(r.h)?.match === 'yes').length;
  const byTier = (t) => { const b = B.filter(r => r.result.tier === t), c = C.filter(r => r.result.tier === t); return `| ${t} | ${pct(b.filter(rej).length, b.length)} | ${pct(c.filter(rej).length, c.length)} |`; };
  const cost = rows.reduce((s, r) => s + (r.result.cost || 0), 0) + [...J.values()].reduce((s, j) => s + (j.usd || 0), 0);
  const md = [
    `# polywatch replay: ${rows.length} commits`, '',
    `| | buggy (later fixed) | clean |`, `|---|---|---|`,
    `| reviewer rejected | ${pct(B.filter(rej).length, B.length)} | ${pct(C.filter(rej).length, C.length)} |`,
    `| trust below 50% | ${pct(B.filter(low).length, B.length)} | ${pct(C.filter(low).length, C.length)} |`,
    `| mean trust | ${Math.round(100 * B.reduce((s, r) => s + r.result.trust.mean, 0) / (B.length || 1))}% | ${Math.round(100 * C.reduce((s, r) => s + r.result.trust.mean, 0) / (C.length || 1))}% |`, '',
    `Rejected buggy commits where an issue matched the bug the later fix repaired (Opus judge): ${pct(matched, B.length)}`,
    `AUC of (1 - trust), buggy vs clean: ${auc.toFixed(2)} (0.5 = no better than chance)`, '',
    `| tier | rejected buggy | rejected clean |`, `|---|---|---|`, byTier('EASY'), byTier('MEDIUM'), byTier('HARD'), '',
    `Total cost: $${cost.toFixed(2)}`,
  ].join('\n');
  writeFileSync(join(out, 'summary.md'), md + '\n');
  console.log(md);
}

// Re-run the current pipeline (confirm, drop refuted, rank, show top N) on the cached Flash reviews
// from results.jsonl, so the new ranking is measured on the same reviewer output. Writes results-v2.jsonl.
async function rerank(out, conc) {
  const ds = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8'));
  const rows = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.result?.reviewer && !r.result.reviewer.error);
  const resPath = join(out, 'results-v2.jsonl');
  const done = new Set(existsSync(resPath) ? readFileSync(resPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).h) : []);
  const state = join(out, 'state-v2'); mkdirSync(join(state, 'jobs'), { recursive: true });
  const todo = rows.filter(r => !done.has(r.h));
  const items = new Map(ds.items.map(it => [it.h, it]));
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const row = todo[idx++], it = items.get(row.h), rv = row.result.reviewer;
      const jobPath = makeJob(ds, it, state, out, '-v2');
      const cached = { text: JSON.stringify({ verdict: rv.verdict, confidence: rv.confidence, summary: rv.summary, issues: rv.issues || [] }), usd: 0, model: rv.model, finish: 'cached' };
      let r; try { r = await runJob(jobPath, { review: async () => cached }); } catch (e) { r = { error: String(e.message || e) }; }
      appendFileSync(resPath, JSON.stringify({ h: row.h, label: row.label, subject: row.subject, result: r }) + '\n');
      console.log(`${row.label.padEnd(5)} ${row.h.slice(0, 8)} tier=${r.tier} findings=${r.findings?.length ?? '-'} shown=${r.shown?.length ?? '-'} confirmed=${r.issues?.length ?? '-'} refuted=${r.refuted ?? '-'} $${(r.cost || 0).toFixed(4)}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}

function score2(out) {
  const v1 = new Map(readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(r => [r.h, r]));
  const J = new Map(readFileSync(join(out, 'judgments.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => { const j = JSON.parse(l); return [j.h, j]; }));
  const rows = readFileSync(join(out, 'results-v2.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.result && !r.result.error);
  const norm = (c) => (c || '').trim().slice(0, 120);
  const bugClaim = (h) => { const j = J.get(h); if (j?.match !== 'yes') return null; const o = v1.get(h).result; const list = [...(o.reviewer?.issues || []), ...((o.adjudications || []).map(a => a.claim))]; return norm(list[j.issue_index]?.claim); };
  const has = (list, c) => c && (list || []).some(f => norm(f.claim) === c);
  const B = rows.filter(r => r.label === 'buggy'), C = rows.filter(r => r.label === 'clean');
  const avg = (rs, f) => (rs.reduce((s, r) => s + f(r), 0) / (rs.length || 1)).toFixed(2);
  const cnt = (rs, f) => `${rs.filter(f).length}/${rs.length}`;
  const known = B.filter(r => bugClaim(r.h));
  const refutedBug = known.filter(r => !has(r.result.findings, bugClaim(r.h)));
  const cost = rows.reduce((s, r) => s + (r.result.cost || 0), 0);
  const md = [
    `# polywatch replay, bug-hunter ranking: ${rows.length} commits (same Flash reviews as v1)`, '',
    `| per commit | buggy (later fixed) | clean |`, `|---|---|---|`,
    `| raw reviewer issues (v1 showed all) | ${avg(B, r => v1.get(r.h).result.reviewer?.issues?.length || 0)} | ${avg(C, r => v1.get(r.h).result.reviewer?.issues?.length || 0)} |`,
    `| findings shown (top ${rows[0]?.result.shown ? 2 : '?'}, score >= threshold) | ${avg(B, r => r.result.shown.length)} | ${avg(C, r => r.result.shown.length)} |`,
    `| Opus-confirmed findings sent to Claude | ${avg(B, r => r.result.issues.length)} | ${avg(C, r => r.result.issues.length)} |`,
    `| commits with "nothing worth your attention" | ${cnt(B, r => !r.result.shown.length)} | ${cnt(C, r => !r.result.shown.length)} |`,
    `| commits with a confirmed finding | ${cnt(B, r => r.result.issues.length > 0)} | ${cnt(C, r => r.result.issues.length > 0)} |`,
    `| claims refuted by Opus | ${B.reduce((s, r) => s + (r.result.refuted || 0), 0)} | ${C.reduce((s, r) => s + (r.result.refuted || 0), 0)} |`, '',
    `Buggy commits where Flash had flagged the real bug (v1 judge): ${known.length}/${B.length}`,
    `- still among the findings after confirmation: ${known.length - refutedBug.length}/${known.length}` + (refutedBug.length ? ` (refuted: ${refutedBug.map(r => r.h.slice(0, 8)).join(', ')})` : ''),
    `- shown to the user (top 2): ${known.filter(r => has(r.result.shown, bugClaim(r.h))).length}/${known.length}`,
    `- confirmed and sent to Claude: ${known.filter(r => has(r.result.issues, bugClaim(r.h))).length}/${known.length}`, '',
    `Opus confirmation cost for this pass: $${cost.toFixed(2)}`,
  ].join('\n');
  writeFileSync(join(out, 'summary-v2.md'), md + '\n');
  console.log(md);
}

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === 'build') build(a1, a2, +arg('--n', 25), +arg('--seed', 1));
else if (cmd === 'run') await run(a1, +arg('--concurrency', 6));
else if (cmd === 'judge') await judge(a1);
else if (cmd === 'score') score(a1);
else if (cmd === 'rerank') await rerank(a1, +arg('--concurrency', 6));
else if (cmd === 'score2') score2(a1);
else console.log('usage: build <repo> <out> [--n 25] | run <out> | judge <out> | score <out> | rerank <out> | score2 <out>');
