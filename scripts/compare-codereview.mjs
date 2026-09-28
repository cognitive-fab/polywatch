#!/usr/bin/env node
// Compare polywatch with the /code-review method (claude-plugins-official/code-review) on sysmobench specs.
//
//   node scripts/compare-codereview.mjs sample <sysmoOut> [--n 100] [--seed 7]
//   node scripts/compare-codereview.mjs run    <sysmoOut> [--concurrency 6]
//   node scripts/compare-codereview.mjs judge  <sysmoOut>
//   node scripts/compare-codereview.mjs score  <sysmoOut>
//
// /code-review reviews a GitHub pull request with five Sonnet agents, scores every issue with a Haiku
// agent on a 0-100 rubric, and keeps issues scored 80 or more. A new spec file in a repository with no
// CLAUDE.md, no history and no earlier pull requests gives three of the five agents nothing to read, so
// this replays the two that apply (#2 obvious bugs in the change, #5 compliance with code comments) and
// the scoring step, with the prompts and rubric taken from the plugin's command file. The pull request
// description is the study's task prompt; the change is the whole spec file.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { callAnthropic } from '../plugin/src/reviewers/anthropic.mjs';
import { callDeepseek } from '../plugin/src/reviewers/deepseek.mjs';
import { parseJson } from '../plugin/src/prompts.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];
const norm = (c) => String(c || '').trim().slice(0, 120);
const SONNET = 'claude-sonnet-5', HAIKU = 'claude-haiku-4-5', OPUS = 'claude-opus-5-5';
const key = () => { const k = process.env.ANTHROPIC_API_KEY; if (!k) throw new Error('ANTHROPIC_API_KEY not set'); return k; };

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function shuffle(a, r) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// 40 planted bugs the checker catches, 20 it misses, 40 verified specs, across the three systems.
const PLAN = { 'mutant:spin': 10, 'mutant:locksvc': 20, 'mutant:etcd': 10, 'mutant-missed:spin': 10, 'mutant-missed:locksvc': 10, 'verified:spin': 15, 'verified:locksvc': 15, 'verified:etcd': 10 };

function sample(out, n, seed) {
  const ds = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8'));
  const done = new Set(readJsonl(join(out, 'results.jsonl')).map(r => r.id));
  const r = rng(seed), picked = [];
  const scale = n / 100;
  for (const [cell, k] of Object.entries(PLAN)) {
    const [label, task] = cell.split(':');
    picked.push(...shuffle(ds.items.filter(it => it.label === label && it.task === task && done.has(it.id)), r).slice(0, Math.round(k * scale)));
  }
  writeFileSync(join(out, 'cr-sample.json'), JSON.stringify(picked.map(it => it.id), null, 2));
  console.log(`sampled ${picked.length}`);
}

const pr = (task, spec) => `===== PULL REQUEST DESCRIPTION =====\n${task}\n\n===== CHANGE: new file spec.js =====\n\`\`\`javascript\n${spec}\n\`\`\``;
const JSON_TAIL = `\n\nReturn a list of issues and the reason each issue was flagged, as one JSON object and nothing else:\n{"issues": [{"where": "<function or line>", "description": "<the issue>", "reason": "<why it was flagged, eg. bug, code comment>"}]}\nReturn {"issues": []} if there are none.`;
const FP = `Examples of false positives:\n- Pre-existing issues\n- Something that looks like a bug but is not actually a bug\n- Pedantic nitpicks that a senior engineer wouldn't call out\n- Issues that a linter, typechecker, or compiler would catch\n- General code quality issues (eg. lack of test coverage, general security issues, poor documentation)\n- Changes in functionality that are likely intentional or are directly related to the broader change\n- Real issues, but on lines that the user did not modify in their pull request`;
const AGENT2 = (task, spec) => `You are reviewing a pull request. Read the file changes in the pull request, then do a shallow scan for obvious bugs. Avoid reading extra context beyond the changes, focusing just on the changes themselves. Focus on large bugs, and avoid small issues and nitpicks. Ignore likely false positives.\n\n${FP}\n\n${pr(task, spec)}${JSON_TAIL}`;
const AGENT5 = (task, spec) => `You are reviewing a pull request. Read code comments in the modified files, and make sure the changes in the pull request comply with any guidance in the comments.\n\n${FP}\n\n${pr(task, spec)}${JSON_TAIL}`;
const SCORER = (task, spec, issue) => `You are checking one issue that a code reviewer raised on a pull request. Score your level of confidence that the issue is real and not a false positive, on a scale from 0-100. The scale is:\na. 0: Not confident at all. This is a false positive that doesn't stand up to light scrutiny, or is a pre-existing issue.\nb. 25: Somewhat confident. This might be a real issue, but may also be a false positive. The agent wasn't able to verify that it's a real issue. If the issue is stylistic, it is one that was not explicitly called out in the relevant CLAUDE.md.\nc. 50: Moderately confident. The agent was able to verify this is a real issue, but it might be a nitpick or not happen very often in practice. Relative to the rest of the PR, it's not very important.\nd. 75: Highly confident. The agent double checked the issue, and verified that it is very likely it is a real issue that will be hit in practice. The existing approach in the PR is insufficient. The issue is very important and will directly impact the code's functionality, or it is an issue that is directly mentioned in the relevant CLAUDE.md.\ne. 100: Absolutely certain. The agent double checked the issue, and confirmed that it is definitely a real issue, that will happen frequently in practice. The evidence directly confirms this.\n\nThis repository has no CLAUDE.md files.\n\n${FP}\n\n${pr(task, spec)}\n\n===== ISSUE =====\nWhere: ${issue.where}\nDescription: ${issue.description}\nReason flagged: ${issue.reason}\n\nReply with one JSON object and nothing else: {"score": <0-100>, "why": "<one sentence>"}`;

async function run(out, conc) {
  const ds = JSON.parse(readFileSync(join(out, 'dataset.json'), 'utf8'));
  const items = new Map(ds.items.map(it => [it.id, it]));
  const ids = JSON.parse(readFileSync(join(out, 'cr-sample.json'), 'utf8'));
  const resPath = join(out, 'cr-results.jsonl');
  const done = new Set(readJsonl(resPath).map(r => r.id));
  const tasks = {};
  const todo = ids.filter(id => !done.has(id));
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const it = items.get(todo[idx++]);
      tasks[it.task] ??= readFileSync(join(ds.tasksDir, `${it.task}.txt`), 'utf8');
      const spec = readFileSync(it.spec, 'utf8');
      let usd = 0, err = null;
      const finishes = [];
      // Sonnet 5 and Haiku think before answering; a low max_tokens is spent on thinking and leaves no answer.
      const call = async (model, prompt, maxTokens) => { const a = await callAnthropic({ model, apiKey: key(), prompt, maxTokens }).catch(e => ({ error: String(e.message || e) })); usd += a.usd || 0; finishes.push(a.finish); if (a.error) err = a.error; else if (a.finish === 'max_tokens') err = `${model} hit max_tokens`; return a; };
      const [a2, a5] = await Promise.all([call(SONNET, AGENT2(tasks[it.task], spec), 48000), call(SONNET, AGENT5(tasks[it.task], spec), 48000)]);
      for (const [n, a] of [[2, a2], [5, a5]]) if (!a.error && !parseJson(a.text)) err = err || `agent ${n} answer unparsed`;
      const raw = [...(parseJson(a2.text)?.issues || []).map(x => ({ ...x, agent: 2 })), ...(parseJson(a5.text)?.issues || []).map(x => ({ ...x, agent: 5 }))].filter(x => x && x.description);
      const scored = await Promise.all(raw.map(async (issue) => { const s = await call(HAIKU, SCORER(tasks[it.task], spec, issue), 24000); const j = parseJson(s.text); return { ...issue, score: typeof j?.score === 'number' ? j.score : null, why: j?.why }; }));
      const kept = scored.filter(x => (x.score ?? 0) >= 80);
      appendFileSync(resPath, JSON.stringify({ id: it.id, label: it.label, task: it.task, raw: scored, kept, usd, error: err }) + '\n');
      console.log(`${it.label.padEnd(13)} ${it.id.padEnd(28)} raw=${raw.length} kept=${kept.length} $${usd.toFixed(4)}${err ? ' ERROR ' + err.slice(0, 80) : ''}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}

// One judge for both arms, so the comparison does not depend on who judged. DeepSeek V4-Pro by default
// (--judge opus to use Claude Opus 5.5). It sees the planted diff and one arm's issue list at a time.
async function judge(out, judgeModel) {
  const J = new Map(readJsonl(join(out, 'judgments.jsonl')).map(j => [j.id, j]));
  const pw = new Map(readJsonl(join(out, 'results.jsonl')).map(r => [r.id, r]));
  const jPath = join(out, 'cr-judgments.jsonl');
  const done = new Set(readJsonl(jPath).map(j => `${j.id}|${j.arm}`));
  const rows = readJsonl(join(out, 'cr-results.jsonl')).filter(r => r.label.startsWith('mutant') && !r.error);
  const jobs = [];
  for (const row of rows) {
    jobs.push({ id: row.id, arm: 'codereview', issues: row.raw.map(x => ({ where: x.where, claim: x.description })) });
    jobs.push({ id: row.id, arm: 'polywatch', issues: (pw.get(row.id)?.result?.reviewer?.issues || []).map(x => ({ where: x.where, claim: x.claim })) });
  }
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const jb = jobs[idx++];
      if (done.has(`${jb.id}|${jb.arm}`)) continue;
      const diff = J.get(jb.id)?.diff;
      if (!diff) { console.log(`${jb.id}: no diff`); continue; }
      if (!jb.issues.length) { appendFileSync(jPath, JSON.stringify({ id: jb.id, arm: jb.arm, match: 'no-issues' }) + '\n'); continue; }
      const prompt = `One behavioral bug was planted in a correct specification. The diff below shows the planted change ("-" original, "+" planted). A reviewer who did not see the diff then listed the issues below.

Decide whether ANY listed issue identifies the planted bug: it must point at the changed code (or its direct effect) and describe the wrong behavior the change causes. An issue about some other part of the file does not count, even if it is valid.

Reply with one JSON object: {"match": "yes" | "no", "issue_index": <number or null>, "why": "<one sentence>"}

===== PLANTED CHANGE =====
${diff}

===== REVIEWER ISSUES =====
${jb.issues.map((x, i) => `${i}. ${x.where || ''}: ${x.claim}`).join('\n')}
`;
      const a = judgeModel === 'opus'
        ? await callAnthropic({ model: OPUS, apiKey: key(), prompt, maxTokens: 16000 }).catch(e => ({ error: String(e.message || e) }))
        : await callDeepseek({ model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY, prompt, maxTokens: 32000 }).catch(e => ({ error: String(e.message || e) }));
      const j = a.error ? null : parseJson(a.text);
      appendFileSync(jPath, JSON.stringify({ id: jb.id, arm: jb.arm, judge: judgeModel, match: j?.match || 'error', issue_index: j?.issue_index ?? null, claim: j?.issue_index != null ? jb.issues[j.issue_index]?.claim : null, why: j?.why || a.error, usd: a.usd || 0 }) + '\n');
      console.log(`${jb.arm.padEnd(10)} ${jb.id} match=${j?.match || 'error'}`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
}

function score(out) {
  const cr = new Map(readJsonl(join(out, 'cr-results.jsonl')).filter(r => !r.error).map(r => [r.id, r]));
  const JJ = readJsonl(join(out, 'cr-judgments.jsonl'));
  const CJ = new Map(JJ.filter(j => j.arm === 'codereview').map(j => [j.id, j]));
  const PJ = new Map(JJ.filter(j => j.arm === 'polywatch').map(j => [j.id, j]));
  const pw = new Map(readJsonl(join(out, 'results.jsonl')).map(r => [r.id, r]));
  const ids = [...cr.keys()].filter(id => pw.has(id) && (!cr.get(id).label.startsWith('mutant') || (CJ.has(id) && PJ.has(id))));
  const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : 'n/a';
  const avg = (xs) => xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length) : 0;
  const pwBug = (id) => PJ.get(id)?.match === 'yes' ? norm(PJ.get(id).claim) : null;
  const pwRaw = (id) => PJ.get(id)?.match === 'yes';
  const pwShown = (id) => { const b = pwBug(id); return !!b && pw.get(id).result.shown.some(f => norm(f.claim) === b); };
  const pwConf = (id) => { const b = pwBug(id); return !!b && pw.get(id).result.issues.some(f => norm(f.claim) === b); };
  const crRaw = (id) => CJ.get(id)?.match === 'yes';
  const crKept = (id) => { const j = CJ.get(id); if (j?.match !== 'yes') return false; const hit = cr.get(id).raw[j.issue_index]; return !!hit && (hit.score ?? 0) >= 80; };
  const lab = (l, t) => ids.filter(id => cr.get(id).label === l && (!t || cr.get(id).task === t));
  const rows = [];
  for (const [label, name] of [['mutant', 'planted bugs the checker catches'], ['mutant-missed', 'planted bugs the checker misses']]) {
    for (const t of [null, 'spin', 'locksvc', 'etcd']) {
      const M = lab(label, t); if (!M.length) continue;
      rows.push(`| ${name}${t ? `, ${t}` : ''} | ${pct(M.filter(pwShown).length, M.length)} | ${pct(M.filter(pwConf).length, M.length)} | ${pct(M.filter(crKept).length, M.length)} | ${pct(M.filter(pwRaw).length, M.length)} | ${pct(M.filter(crRaw).length, M.length)} |`);
    }
  }
  const V = lab('verified');
  const vRows = [null, 'spin', 'locksvc', 'etcd'].map(t => { const X = lab('verified', t); if (!X.length) return null; return `| verified specs${t ? `, ${t}` : ''} (${X.length}) | ${pct(X.filter(id => pw.get(id).result.shown.length > 0).length, X.length)} | ${pct(X.filter(id => pw.get(id).result.issues.length > 0).length, X.length)} | ${pct(X.filter(id => cr.get(id).kept.length > 0).length, X.length)} | ${pct(X.filter(id => cr.get(id).raw.length > 0).length, X.length)} |`; }).filter(Boolean);
  const cost = (sel, f) => avg(ids.filter(sel).map(f));
  const md = [
    `# polywatch vs the /code-review method: ${ids.length} sysmobench specs`, '',
    'polywatch: DeepSeek Flash review, Opus 5.5 confirms up to 2 claims, top 2 shown (default settings; results from the main sysmobench run).',
    '/code-review: two Sonnet 5 review agents (#2 obvious bugs, #5 code comments), Haiku 4.5 scores each issue 0-100, issues scored 80+ reported.', '',
    '## Planted bugs found', '',
    '| | polywatch: shown | polywatch: confirmed | /code-review: reported (80+) | polywatch: Flash raised it | /code-review: any agent raised it |', '|---|---|---|---|---|---|', ...rows, '',
    '## Correct specs with something reported (false alarms, upper bound)', '',
    '| | polywatch: shown | polywatch: confirmed | /code-review: reported (80+) | /code-review: raised before scoring |', '|---|---|---|---|---|', ...vRows, '',
    '## Items reported per spec', '',
    `| | polywatch shown | /code-review reported |`, `|---|---|---|`,
    ...['mutant', 'mutant-missed', 'verified'].map(l => `| ${l} | ${avg(lab(l).map(id => pw.get(id).result.shown.length)).toFixed(2)} | ${avg(lab(l).map(id => cr.get(id).kept.length)).toFixed(2)} |`), '',
    '## Cost per spec', '',
    `| system | polywatch | /code-review |`, `|---|---|---|`,
    ...['spin', 'locksvc', 'etcd'].map(t => `| ${t} | $${cost(id => cr.get(id).task === t, id => pw.get(id).result.cost || 0).toFixed(4)} | $${cost(id => cr.get(id).task === t, id => cr.get(id).usd).toFixed(4)} |`),
    `| all | $${cost(() => true, id => pw.get(id).result.cost || 0).toFixed(4)} | $${cost(() => true, id => cr.get(id).usd).toFixed(4)} |`, '',
    `Judge: ${JJ[0]?.judge || '?'}, the same for both arms, shown the planted diff. Judge cost: $${JJ.reduce((s, j) => s + (j.usd || 0), 0).toFixed(2)}.`,
  ].join('\n');
  writeFileSync(join(out, 'cr-summary.md'), md + '\n');
  console.log(md);
}

const [cmd, a1] = process.argv.slice(2);
if (cmd === 'sample') sample(a1, +arg('--n', 100), +arg('--seed', 7));
else if (cmd === 'run') await run(a1, +arg('--concurrency', 6));
else if (cmd === 'judge') await judge(a1, arg('--judge', 'deepseek'));
else if (cmd === 'score') score(a1);
else console.log('usage: sample <out> [--n 100] | run <out> | judge <out> | score <out>');
