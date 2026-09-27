// Background review of one turn: route, list candidate defects, confirm the serious ones, rank, log.
import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, stateDir } from './config.mjs';
import { readJson, writeJson, appendJsonl, isExcluded, safeId } from './util.mjs';
import { features, route } from './router.mjs';
import { calibration, rank } from './rank.mjs';
import { reviewPrompt, claimPrompt, parseJson } from './prompts.mjs';
import { callDeepseek } from './reviewers/deepseek.mjs';
import { callAnthropic } from './reviewers/anthropic.mjs';
import { refreshDashboard } from './dashboard.mjs';
import { callClaudeCode } from './reviewers/claudecode.mjs';

export function buildUnits(job, cfg) {
  const byFile = new Map();
  for (const e of job.edits) {
    if (isExcluded(job.cwd, e.file, cfg.exclude)) continue;
    // Files outside the project (Claude's scratch scripts, temp files) are not sent unless asked for.
    const rel = relative(job.cwd, e.file);
    if (!cfg.reviewOutsideProject && (rel.startsWith('..') || isAbsolute(rel))) continue;
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const units = [];
  for (const [file, edits] of byFile) {
    let current = '';
    if (job.snapshots && file in job.snapshots) current = job.snapshots[file];
    else { try { current = readFileSync(file, 'utf8'); } catch { current = '(file no longer exists)'; } }
    const truncated = current.length > cfg.maxFileBytes;
    units.push({ file, rel: relative(job.cwd, file).split(sep).join('/'), edits, current: truncated ? current.slice(0, cfg.maxFileBytes) : current, truncated });
  }
  return units;
}

// The code a claim is checked against. The cited file is sent whole when it fits; otherwise, and for
// the other changed files, only windows around the identifiers the claim names. An excerpt that stops
// before the cited code makes the adjudicator answer "uncertain" (BaanBaan replay: 23 of 34 claims).
const STOP = new Set(['this', 'that', 'with', 'when', 'then', 'from', 'into', 'does', 'will', 'which', 'there', 'their', 'only', 'never', 'always', 'return', 'returns', 'function', 'const', 'value', 'values', 'because', 'without', 'should', 'would', 'every', 'other', 'before', 'after', 'while', 'where', 'line', 'lines', 'code', 'file', 'call', 'calls', 'called', 'handler', 'route', 'check', 'checks']);
export function anchorsOf(claim) {
  const text = `${claim.where || ''} ${claim.claim || ''}`;
  const ticks = [...text.matchAll(/`([^`]{2,80})`/g)].map(m => m[1]);
  const idents = [...text.matchAll(/[A-Za-z_$][\w$]{3,}/g)].map(m => m[0]).filter(w => !STOP.has(w.toLowerCase()) && (/[A-Z_$]/.test(w.slice(1)) || /\(/.test(text.slice(text.indexOf(w) + w.length, text.indexOf(w) + w.length + 1))));
  const fromTicks = ticks.flatMap(t => t.match(/[A-Za-z_$][\w$./-]{2,}/g) || []);
  const fromWhere = (claim.where || '').match(/[A-Za-z_$][\w$]{2,}/g)?.filter(w => !STOP.has(w.toLowerCase())) || [];
  return [...new Set([...fromTicks, ...fromWhere, ...idents])].filter(a => a.length >= 3).slice(0, 16);
}

// Pick the lines that best match the claim's identifiers, rarer identifiers weighing more, and send
// windows around them in order of relevance until the budget is spent.
function windows(text, anchors, budget, radius = 40) {
  const lines = text.split('\n');
  const hits = anchors.map(a => { const idx = []; lines.forEach((l, i) => { if (l.includes(a)) idx.push(i); }); return { a, idx }; }).filter(h => h.idx.length);
  if (!hits.length) return '';
  const score = new Map();
  for (const h of hits) { const w = 1 / h.idx.length; for (const i of h.idx) score.set(i, (score.get(i) || 0) + w); }
  const centers = [...score.entries()].sort((x, y) => y[1] - x[1]).map(([i]) => i);
  const chosen = []; let used = 0;
  for (const c of centers) {
    if (chosen.some(([s0, e0]) => c >= s0 && c < e0)) continue;
    const w = [Math.max(0, c - radius), Math.min(lines.length, c + radius + 1)];
    const len = lines.slice(w[0], w[1]).join('\n').length;
    if (used + len > budget) { if (chosen.length) break; }
    chosen.push(w); used += len;
    if (chosen.length >= 6) break;
  }
  chosen.sort((x, y) => x[0] - y[0]);
  const merged = []; for (const w of chosen) { const last = merged[merged.length - 1]; if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else merged.push([...w]); }
  return merged.map(([s0, e0]) => `// lines ${s0 + 1}-${e0}\n` + lines.slice(s0, e0).join('\n')).join('\n// ...\n').slice(0, budget);
}

// Whether a claim's file names this unit: equal, or one path ends with the other at a '/' boundary.
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
export function sameFile(unit, claimFile) {
  const c = norm(claimFile), rel = norm(unit.rel), abs = norm(unit.file);
  if (!c) return false;
  return rel === c || abs === c || abs.endsWith('/' + c) || c.endsWith('/' + rel);
}

export function excerptFor(units, claim, budget = 40000) {
  const primary = units.find(x => sameFile(x, claim.file)) || units[0];
  if (!primary) return '';
  const anchors = anchorsOf(claim);
  const parts = [];
  const add = (label, body) => { if (!body || budget <= 0) return; const b = body.slice(0, budget); parts.push(`// ===== ${label} =====\n${b}`); budget -= b.length; };
  if (primary.current.length <= budget * 0.75) add(primary.rel, primary.current);
  else add(`${primary.rel} (excerpts around the cited code)`, windows(primary.current, anchors, budget * 0.75) || primary.current.slice(0, budget * 0.75));
  for (const u of units) if (u !== primary && anchors.length) add(`${u.rel} (excerpts)`, windows(u.current, anchors, Math.min(budget, 8000), 25));
  return parts.join('\n\n');
}

// One model call for a role ('reviewer' or 'adjudicator'). Keys and endpoints come from loadConfig,
// which only lets the user's own config (or a trusted project) choose them.
function callRole(cfg, role, prompt, maxTokens) {
  const r = cfg[role];
  // Through Claude Code on the user's plan: no API key involved.
  if (r.provider === 'claude-code') return callClaudeCode({ model: r.model, prompt });
  // The key set in the plugin's settings (Claude Code stores it in the OS credential store and passes it
  // to hooks as CLAUDE_PLUGIN_OPTION_<KEY>), else the environment variable named in the config.
  const optionVar = `CLAUDE_PLUGIN_OPTION_${String(r.provider).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const apiKey = process.env[optionVar] || process.env[r.apiKeyEnv];
  if (!apiKey) return Promise.resolve({ error: `no ${r.provider} API key: set it in the plugin's settings (/plugin, polywatch, Configure) or in ${r.apiKeyEnv}` });
  if (r.provider === 'deepseek') return callDeepseek({ model: r.model, baseUrl: r.baseUrl, apiKey, prompt, price: r.price, ...(maxTokens && { maxTokens }) });
  if (r.provider === 'anthropic') return callAnthropic({ model: r.model, apiKey, prompt, price: r.price });
  return Promise.resolve({ error: `unknown ${role} provider ${r.provider}` });
}

export async function runJob(jobPath, deps = {}) {
  const job = readJson(jobPath);
  const cfg = loadConfig(job.configDir || job.cwd);
  const dir = stateDir(job.stateDir || job.cwd);
  // The dashboard (if the user made one) shows this review as running now, and the result when it ends.
  const dash = () => { if (!job.stateDir) refreshDashboard(job.cwd, cfg); };
  dash();
  const review = deps.review || ((p) => callRole(cfg, 'reviewer', p));
  const adjudicate = deps.adjudicate || ((p) => callRole(cfg, 'adjudicator', p, 64000));
  const result = { id: job.id, session: job.session, createdAt: new Date().toISOString(), cost: 0, notes: cfg.warnings.map(w => `Config: ${w}`) };
  const unpriced = new Set();
  const spent = (call) => { result.cost += call.usd || 0; if (call.unpriced) unpriced.add(call.unpriced); };

  const units = buildUnits(job, cfg);
  const f = features(units);
  const r = route(f);
  Object.assign(result, { files: units.map(u => u.rel), features: f, tier: r.tier, tierReason: r.why });

  if (!units.length || f.changedLines < cfg.minChangedLines) {
    result.skipped = !units.length ? 'no reviewable files (all excluded or outside the project)' : `only ${f.changedLines} changed lines`;
    return dash(), finish(dir, jobPath, result);
  }

  // Step 1: cheap reviewer from another model family lists candidate defects.
  const prompt = reviewPrompt({ task: job.task, units });
  let rv = await review(prompt).catch(e => ({ error: String(e.message || e) }));
  spent(rv);
  let verdict = rv.error ? null : parseJson(rv.text);
  if (!rv.error && !verdict) {
    // An empty or unparseable answer happens occasionally with reasoning models: retry once.
    rv = await review(prompt).catch(e => ({ error: String(e.message || e) }));
    spent(rv);
    verdict = rv.error ? null : parseJson(rv.text);
    result.reviewerRetried = true;
  }
  result.reviewer = rv.error ? { error: rv.error } : { model: cfg.reviewer.model, seconds: rv.seconds, usd: rv.usd, finish: rv.finish, ...(verdict || { unparsed: String(rv.text).slice(0, 300) }) };
  if (!rv.error && !verdict) result.notes.push(`Reviewer returned no answer (finish reason: ${rv.finish || 'unknown'}).`);
  // The reviewer's ACCEPT/REJECT verdict is kept for the record but not used: on real project
  // history it rejected commits that were later fixed and commits that were not at the same rate.
  const candidates = (verdict?.issues || []).filter(i => i && i.claim);

  // Step 2: machine check for hard changes, when the project has one.
  if (r.tier === 'HARD' && cfg.testCommand) {
    const t0 = Date.now();
    const out = spawnSync(cfg.testCommand, { cwd: job.cwd, shell: true, timeout: cfg.testTimeoutSec * 1000, encoding: 'utf8' });
    result.tests = { command: cfg.testCommand, passed: out.status === 0, seconds: (Date.now() - t0) / 1000, tail: String(out.stdout || '').slice(-800) + String(out.stderr || '').slice(-400) };
  }

  // Step 3: confirm the most serious candidates one claim at a time against the cited code.
  const sevRank = { high: 0, medium: 1, low: 2 };
  const eligible = candidates
    .filter(i => cfg.confirm === 'all' || (cfg.confirm === 'high' ? i.severity === 'high' : cfg.confirm === 'top' ? i.severity !== 'low' : false))
    .sort((a, b) => (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1));
  result.adjudications = [];
  for (const claim of eligible.slice(0, cfg.adjudicator.maxClaims)) {
    if (result.cost >= cfg.budgetUsdPerTurn) { result.notes.push('Per-turn budget reached; remaining claims were not checked.'); break; }
    const inc = cfg.adjudicator.includeRequest ?? 'short';          // 'short' (requests up to 20,000 chars) | 'always' | 'never'
    const request = job.task && (inc === 'always' || (inc === 'short' && job.task.length <= 20000)) ? job.task : null;
    const prompt = claimPrompt({ claim, excerpt: excerptFor(units, claim), request });
    let a = await adjudicate(prompt).catch(e => ({ error: String(e.message || e) }));
    spent(a);
    let j = a.error ? null : parseJson(a.text);
    if (!a.error && !j?.holds && result.cost < cfg.budgetUsdPerTurn) {          // one retry on an empty or unparseable answer
      a = await adjudicate(prompt).catch(e => ({ error: String(e.message || e) }));
      spent(a);
      j = a.error ? null : parseJson(a.text);
    }
    result.adjudications.push({ claim, holds: j?.holds || 'error', evidence: j?.evidence || a.error || (a.finish === 'refusal' ? 'the model declined' : `unparsed (${a.finish || '?'}): ${String(a.text || '').slice(0, 200)}`), usd: a.usd || 0 });
    if (a.error) { result.notes.push(`Adjudicator unavailable (${a.error}); claims left unconfirmed.`); break; }
  }

  // Step 4: rank. Refuted claims are dropped; confirmed ones carry the adjudicator's evidence.
  const byClaim = new Map(result.adjudications.map(a => [a.claim, a]));
  const findings = [];
  for (const c of candidates) {
    const a = byClaim.get(c);
    if (a?.holds === 'no') continue;
    findings.push({ file: c.file, where: c.where, severity: c.severity, claim: c.claim, status: a?.holds === 'yes' ? 'confirmed' : 'unconfirmed', evidence: a?.holds === 'yes' ? a.evidence : undefined });
  }
  result.refuted = result.adjudications.filter(a => a.holds === 'no').length;
  result.findings = rank(findings, calibration(dir));
  result.shown = result.findings.filter(x => x.score >= cfg.minScore).slice(0, cfg.maxFindings);
  // Only confirmed findings go back to Claude, and not only the ones shown: maxFindings limits what
  // the user reads, while Claude checks each finding against the code before fixing it.
  result.issues = result.findings.filter(x => x.status === 'confirmed' && x.score >= cfg.minScore).slice(0, cfg.maxToClaude);
  if (r.tier === 'HARD' && !result.tests) result.notes.push('Hard change and no machine check configured: set "testCommand" in .polywatch.json, or run polygraph on the state machine.');
  if (result.tests && !result.tests.passed) result.notes.push(`Tests failed: ${cfg.testCommand}`);
  const done = finish(dir, jobPath, result, unpriced);
  dash();
  return done;
}

function finish(dir, jobPath, result, unpriced = new Set()) {
  if (unpriced.size) result.notes.push(`No price known for ${[...unpriced].join(', ')}; cost was estimated at the highest known price. Set "price": [input, output] (USD per million tokens) for it in ~/.polywatch.json.`);
  writeJson(join(dir, 'results', `${result.id}.json`), result);
  // Marker for delivery on the next prompt; manual reviews are printed directly instead.
  if (result.session && result.session !== 'manual') {
    const inbox = join(dir, 'inbox', safeId(result.session));
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, `${result.id}.json`), '{}');
  }
  appendJsonl(join(dir, 'ledger.jsonl'), { kind: 'review', ...result, units: undefined });
  try { if (existsSync(jobPath)) unlinkSync(jobPath); } catch {}
  return result;
}
