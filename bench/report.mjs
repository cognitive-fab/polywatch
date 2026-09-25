#!/usr/bin/env node
// Summarise a benchmark run: success per arm, time and tokens to success, cost, and paired comparisons.
// Usage: node bench/report.mjs <out dir>   (writes <out>/report.md and prints it)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve(process.argv[2] || 'bench/out/pilot');
const runs = readFileSync(join(OUT, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const arms = [...new Set(runs.map(r => r.arm))];
const key = (r) => `${r.lang}/${r.task}/r${r.rep}`;
const byArm = Object.fromEntries(arms.map(a => [a, new Map(runs.filter(r => r.arm === a).map(r => [key(r), r]))]));
// Compare arms only on tasks every arm finished.
const common = [...byArm[arms[0]].keys()].filter(k => arms.every(a => byArm[a].has(k)));

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const tokens = (r) => (r.tokens?.input || 0) + (r.tokens?.output || 0) + (r.tokens?.cacheRead || 0) + (r.tokens?.cacheWrite || 0);
const usd = (r) => (r.claudeUsd || 0) + (r.polywatch?.usd || 0);
const f$ = (x) => Number.isFinite(x) ? `$${x.toFixed(3)}` : '-';
const fs = (ms) => Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : '-';
const fk = (x) => Number.isFinite(x) ? `${Math.round(x / 1000)}k` : '-';

// Exact two-sided McNemar test on the discordant pairs.
function mcnemar(b, c) {
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c); let p = 0;
  for (let i = 0; i <= k; i++) { let comb = 1; for (let j = 0; j < i; j++) comb = comb * (n - j) / (j + 1); p += comb; }
  return Math.min(1, 2 * p / 2 ** n);
}

const rows = arms.map(a => {
  const rs = common.map(k => byArm[a].get(k)), ok = rs.filter(r => r.passed);
  return { a, n: rs.length, pass: ok.length,
    timeOk: median(ok.map(r => r.ms)), tokOk: median(ok.map(tokens)),
    time: median(rs.map(r => r.ms)), usdAll: sum(rs.map(usd)), pwUsd: sum(rs.map(r => r.polywatch?.usd || 0)),
    usdPerPass: ok.length ? sum(rs.map(usd)) / ok.length : NaN, tokPerPass: ok.length ? sum(rs.map(tokens)) / ok.length : NaN,
    errors: rs.filter(r => r.errors?.length).length };
});

const lines = [];
lines.push(`# Benchmark: ${OUT}`, '', `${common.length} task runs finished in every arm (${arms.join(', ')}). Model: ${runs[0]?.model}.`, '');
lines.push('| arm | passed | median time (passed runs) | median tokens (passed runs) | total cost | of which polywatch | cost per pass | tokens per pass | runs with errors |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${r.a} | ${r.pass}/${r.n} (${Math.round(100 * r.pass / (r.n || 1))}%) | ${fs(r.timeOk)} | ${fk(r.tokOk)} | ${f$(r.usdAll)} | ${r.pwUsd ? f$(r.pwUsd) : '-'} | ${f$(r.usdPerPass)} | ${fk(r.tokPerPass)} | ${r.errors} |`);
lines.push('', 'Tokens are Claude Code tokens (input, output and cache); polywatch\'s own model calls appear only in cost. "Cost per pass" is total cost divided by passed runs.', '');

if (arms.length > 1) {
  lines.push('## Paired comparison (same task and repetition)', '', '| arms | both pass | only first | only second | neither | McNemar p |', '|---|---|---|---|---|---|');
  for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    let both = 0, b = 0, c = 0, none = 0;
    for (const k of common) { const x = byArm[arms[i]].get(k).passed, y = byArm[arms[j]].get(k).passed; if (x && y) both++; else if (x) b++; else if (y) c++; else none++; }
    lines.push(`| ${arms[i]} vs ${arms[j]} | ${both} | ${b} | ${c} | ${none} | ${mcnemar(b, c).toFixed(3)} |`);
  }
  lines.push('');
}

const pw = runs.filter(r => r.arm === 'polywatch' && r.polywatch);
if (pw.length) {
  const withFindings = pw.filter(r => r.polywatch.confirmed > 0);
  lines.push('## polywatch', '',
    `- ${sum(pw.map(r => r.polywatch.reviews))} reviews in ${pw.length} runs (${sum(pw.map(r => r.polywatch.skipped))} skipped as too small), ${f$(sum(pw.map(r => r.polywatch.usd)))} in total.`,
    `- Confirmed defects were handed back in ${withFindings.length} runs (${sum(pw.map(r => r.polywatch.confirmed))} findings); ${withFindings.filter(r => r.passed).length} of those runs passed.`, '');
  const plain = byArm.plain;
  if (plain) {
    const flips = withFindings.filter(r => plain.get(key(r)) && !plain.get(key(r)).passed && r.passed).map(key);
    const hurt = pw.filter(r => plain.get(key(r))?.passed && !r.passed).map(key);
    lines.push(`- Failed plain, passed with polywatch findings handed back: ${flips.join(', ') || 'none'}.`, `- Passed plain, failed with polywatch: ${hurt.join(', ') || 'none'}.`, '');
  }
}

const failed = runs.filter(r => !r.passed);
if (failed.length) lines.push('## Failed runs', '', ...failed.map(r => `- ${r.id}${r.errors?.length ? ` (error: ${String(r.errors[0]).slice(0, 100)})` : ''}`), '');
const text = lines.join('\n');
writeFileSync(join(OUT, 'report.md'), text);
console.log(text);
