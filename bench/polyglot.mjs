#!/usr/bin/env node
// Benchmark: Claude Code alone vs Claude Code + polywatch on Aider's polyglot benchmark (Exercism
// exercises with hidden unit tests). Each run solves one exercise headless in a fresh folder; the
// tests are copied in only afterwards, to score it.
//
// Arms (same model, same tasks, same prompt):
//   plain      one headless run
//   selfcheck  one run, then the session is resumed with a fixed "check your work" prompt
//   polywatch  one run with polywatch loaded in deliver: 'stop' mode: before Claude stops, the turn is
//              reviewed and confirmed defects are handed back to it
// selfcheck is the control for "polywatch gives Claude a second pass".
//
// Usage: node bench/polyglot.mjs --data <polyglot-benchmark dir> --out <dir>
//          [--langs python,rust] [--n 30] [--arms plain,selfcheck,polywatch] [--reps 1] [--jobs 3]
//          [--model claude-opus-5-5] [--only <lang/exercise,...>]
// Results are appended to <out>/runs.jsonl; finished runs are skipped when re-run. Summarise with
// node bench/report.mjs <out>.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLYWATCH = resolve(HERE, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const DATA = resolve(arg('data', 'bench-data/polyglot-benchmark'));
const OUT = resolve(arg('out', join(HERE, 'out', 'pilot')));
const LANGS = arg('langs', 'python,rust').split(',');
const N = Number(arg('n', 30));
const ARMS = arg('arms', 'plain,selfcheck,polywatch').split(',');
const REPS = Number(arg('reps', 1));
const JOBS = Number(arg('jobs', 3));
const MODEL = arg('model', 'claude-opus-5-5');
const ONLY = arg('only', null)?.split(',');
const RUN_TIMEOUT = 45 * 60e3;
// Without the Visual Studio C++ build tools the default MSVC Rust toolchain cannot link (and Git Bash's
// coreutils link shadows link.exe). The GNU toolchain links on its own; used for Claude's runs and scoring.
const RUST_TOOLCHAIN = process.env.BENCH_RUST_TOOLCHAIN ?? (process.platform === 'win32' ? 'stable-x86_64-pc-windows-gnu' : '');

const SELF_CHECK = 'Check your work against the instructions above: read your solution again, look for bugs and unhandled cases, and fix anything that is wrong. The tests are still not available. If nothing needs changing, reply DONE.';

// ---- tasks -------------------------------------------------------------------------------------
function tasks() {
  // --only names exercises directly, whether or not the even spread would have picked them.
  if (ONLY) return ONLY.flatMap(s => {
    const [lang, name] = s.split('/');
    const dir = lang && name ? join(DATA, lang, 'exercises', 'practice', name) : null;
    if (dir && existsSync(dir)) return [{ lang, name, dir }];
    console.error(`no such exercise: ${s} (expected <lang>/<exercise>, e.g. python/bowling)`);
    return [];
  });
  const per = Math.ceil(N / LANGS.length), out = [];
  for (const lang of LANGS) {
    const dir = join(DATA, lang, 'exercises', 'practice');
    const all = readdirSync(dir).sort();
    const step = Math.max(1, Math.floor(all.length / per));      // spread evenly, deterministic
    for (let i = 0; i < all.length && out.filter(t => t.lang === lang).length < per; i += step) out.push({ lang, name: all[i], dir: join(dir, all[i]) });
  }
  return out.slice(0, N);
}

const meta = (t) => JSON.parse(readFileSync(join(t.dir, '.meta', 'config.json'), 'utf8')).files;

// The exercise without its tests and without .meta (which holds the reference solution).
function prepare(t, work) {
  rmSync(work, { recursive: true, force: true });
  const tests = new Set(meta(t).test.map(f => f.split('/')[0]));
  cpSync(t.dir, work, { recursive: true, filter: (src) => {
    const rel = src.slice(t.dir.length + 1).split(/[\\/]/);
    return !(rel[0] === '.meta' || tests.has(rel[0]) || (rel.length === 1 && /_test\.py$/.test(rel[0])));
  } });
}

function prompt(t) {
  const docs = join(t.dir, '.docs');
  const text = ['introduction.md', 'instructions.md', 'instructions.append.md'].filter(f => existsSync(join(docs, f))).map(f => readFileSync(join(docs, f), 'utf8')).join('\n\n');
  const files = meta(t).solution.join(', ');
  return `${text}\n\n####\n\nUse the above instructions to modify the supplied files: ${files}\nDon't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.\nOnly use standard libraries, don't suggest installing any packages.\nThe unit tests are not available to you; they will be run after you finish.`;
}

// ---- running Claude Code -------------------------------------------------------------------------
function claude(args, input, cwd, env) {
  return new Promise((res) => {
    const t0 = Date.now();
    const c = spawn('claude', args, { cwd, env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => c.kill(), RUN_TIMEOUT);
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', (code) => {
      clearTimeout(timer);
      let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch {}
      res({ ms: Date.now() - t0, code, json: j, err: err.slice(-2000) });
    });
    c.stdin.end(input);
  });
}

function usageOf(j) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of Object.values(j?.modelUsage || {})) { u.input += m.inputTokens || 0; u.output += m.outputTokens || 0; u.cacheRead += m.cacheReadInputTokens || 0; u.cacheWrite += m.cacheCreationInputTokens || 0; }
  return u;
}

const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

// ---- scoring ---------------------------------------------------------------------------------------
function score(t, work) {
  // Copy back everything prepare() hid, not only the listed test files: tests/ can hold fixtures
  // (rust/macros keeps its compile-fail cases in tests/invalid/).
  for (const top of new Set(meta(t).test.map(f => f.split('/')[0]))) cpSync(join(t.dir, top), join(work, top), { recursive: true });
  const run = t.lang === 'python'
    ? spawnSync('python', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...meta(t).test], { cwd: work, encoding: 'utf8', timeout: 180e3 })
    : spawnSync('cargo', ['test', '--', '--include-ignored'], { cwd: work, encoding: 'utf8', timeout: 600e3, env: { ...process.env, ...(RUST_TOOLCHAIN && { RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN }), CARGO_TARGET_DIR: join(OUT, 'cargo-target', `${basename(dirname(work))}-${basename(work)}`) } });
  const text = `${run.stdout || ''}\n${run.stderr || ''}`;
  return { passed: run.status === 0, tail: text.slice(-1500) };
}

// ---- one run -------------------------------------------------------------------------------------------
async function runOne(t, arm, rep, env) {
  const id = `${arm}/${t.lang}-${t.name}-r${rep}`;
  const work = join(OUT, 'work', arm, `${t.lang}-${t.name}-r${rep}`);
  prepare(t, work);
  // --setting-sources project: no user settings, so none of the user's own hooks or plugins run in any arm.
  const base = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', MODEL, '--setting-sources', 'project'];
  const armArgs = arm === 'polywatch' ? [...base, '--plugin-dir', POLYWATCH] : base;
  const calls = [await claude(armArgs, prompt(t), work, env)];
  if (arm === 'selfcheck' && calls[0].json?.session_id) calls.push(await claude([...base, '--resume', calls[0].json.session_id], SELF_CHECK, work, env));
  const pw = readJsonl(join(work, '.polywatch', 'ledger.jsonl')).filter(l => l.kind === 'review');
  const s = score(t, work);
  const tok = calls.map(c => usageOf(c.json)).reduce((a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] + b[k]])));
  return {
    id, arm, lang: t.lang, task: t.name, rep, model: MODEL, at: new Date().toISOString(),
    passed: s.passed, ms: calls.reduce((a, c) => a + c.ms, 0),
    claudeUsd: calls.reduce((a, c) => a + (c.json?.total_cost_usd || 0), 0),
    turns: calls.reduce((a, c) => a + (c.json?.num_turns || 0), 0),
    tokens: tok,
    polywatch: arm === 'polywatch' ? { reviews: pw.length, usd: pw.reduce((a, r) => a + (r.cost || 0), 0), confirmed: pw.reduce((a, r) => a + (r.issues?.length || 0), 0), skipped: pw.filter(r => r.skipped).length } : null,
    errors: calls.filter(c => !c.json || c.json.is_error).map(c => c.json?.result || c.err || `exit ${c.code}`),
    testTail: s.passed ? undefined : s.tail,
  };
}

// ---- main ------------------------------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const pwConfig = join(OUT, 'polywatch-user.json');
  writeFileSync(pwConfig, JSON.stringify({ deliver: 'stop', adjudicator: { maxClaims: 6 },
    providers: { deepseek: { apiKeyEnv: 'POLYWATCH_DEEPSEEK_API_KEY' }, anthropic: { apiKeyEnv: 'POLYWATCH_ANTHROPIC_API_KEY' } } }, null, 2));
  const env = { ...process.env, POLYWATCH_USER_CONFIG: pwConfig, ...(RUST_TOOLCHAIN && { RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN }) };
  delete env.CLAUDE_PROJECT_DIR;
  for (const k of ['POLYWATCH_DEEPSEEK_API_KEY', 'POLYWATCH_ANTHROPIC_API_KEY']) if (ARMS.includes('polywatch') && !env[k]) throw new Error(`${k} is not set in this shell`);

  const runsPath = join(OUT, 'runs.jsonl');
  const done = new Set(readJsonl(runsPath).map(r => r.id));
  const queue = [];
  const ts = tasks();
  // Interleave arms per task so that load on the machine hits every arm alike.
  for (let rep = 1; rep <= REPS; rep++) for (const t of ts) for (const arm of ARMS) if (!done.has(`${arm}/${t.lang}-${t.name}-r${rep}`)) queue.push({ t, arm, rep });
  console.log(`${ts.length} tasks x ${ARMS.length} arms x ${REPS} reps: ${queue.length} runs to do (${done.size} already done) -> ${OUT}`);
  let next = 0, finished = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (next < queue.length) {
      const { t, arm, rep } = queue[next++];
      let r;
      try { r = await runOne(t, arm, rep, env); } catch (e) { r = { id: `${arm}/${t.lang}-${t.name}-r${rep}`, arm, lang: t.lang, task: t.name, rep, passed: false, errors: [String(e.stack || e)] }; }
      appendFileSync(runsPath, JSON.stringify(r) + '\n');
      finished++;
      console.log(`[${finished}/${queue.length}] ${r.id} ${r.passed ? 'PASS' : 'FAIL'} ${Math.round((r.ms || 0) / 1000)}s $${(r.claudeUsd || 0).toFixed(3)}${r.polywatch ? ` +pw $${r.polywatch.usd.toFixed(3)} (${r.polywatch.confirmed} confirmed)` : ''}${r.errors?.length ? ` errors: ${String(r.errors[0]).slice(0, 120)}` : ''}`);
    }
  }));
}
// --rescore: score the existing work folders again (after fixing the scorer) without re-running Claude.
function rescore() {
  const runsPath = join(OUT, 'runs.jsonl');
  const runs = readJsonl(runsPath);
  for (const r of runs) {
    const t = { lang: r.lang, name: r.task, dir: join(DATA, r.lang, 'exercises', 'practice', r.task) };
    const s = score(t, join(OUT, 'work', r.arm, `${r.lang}-${r.task}-r${r.rep}`));
    if (s.passed !== r.passed) console.log(`${r.id}: ${r.passed ? 'PASS' : 'FAIL'} -> ${s.passed ? 'PASS' : 'FAIL'}`);
    r.passed = s.passed; r.testTail = s.passed ? undefined : s.tail; r.rescored = new Date().toISOString();
  }
  writeFileSync(runsPath, runs.map(r => JSON.stringify(r)).join('\n') + '\n');
}
if (process.argv.includes('--rescore')) rescore(); else main();
