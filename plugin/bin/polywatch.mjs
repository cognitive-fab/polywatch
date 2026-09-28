#!/usr/bin/env node
// polywatch CLI: Claude Code hook entry points, the background worker, and reports.
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, stateDir, inScope, projectRoot } from '../src/config.mjs';
import { readStdin, readJson, writeJson, appendJsonl, listJson, safeId, lastUserText } from '../src/util.mjs';
import { runJob } from '../src/worker.mjs';
import { changedSince } from '../src/scan.mjs';
import { writeDashboard, refreshDashboard, openInBrowser, dashboardPath } from '../src/dashboard.mjs';
import { collect, renderReport } from '../src/deliver.mjs';
import { firstRunNotice } from '../src/spend.mjs';

const SELF = fileURLToPath(import.meta.url);
const out = (obj) => { if (obj) process.stdout.write(JSON.stringify(obj)); };

function editsFromToolInput(tool, ti) {
  const file = ti?.file_path; if (!file) return [];
  if (tool === 'Write') return [{ file, tool, before: null, after: String(ti.content ?? '') }];
  if (tool === 'Edit') return [{ file, tool, before: String(ti.old_string ?? ''), after: String(ti.new_string ?? '') }];
  if (tool === 'MultiEdit') return (ti.edits || []).map(e => ({ file, tool, before: String(e.old_string ?? ''), after: String(e.new_string ?? '') }));
  return [];
}

async function hook(kind) {
  const input = JSON.parse((await readStdin()) || '{}');
  const shellCwd = input.cwd || process.cwd();         // where Claude's shell is now; resolves relative file paths
  const cwd = projectRoot(shellCwd);                   // where state lives and what the review is relative to
  const session = safeId(input.session_id);
  const cfg = loadConfig(cwd);
  if (!inScope(cfg, cwd)) return;   // outside the user's onlyUnder folders: record nothing, send nothing
  const dir = stateDir(cwd);
  // One file per tool call: hooks for parallel edits run at the same time and must not share a file.
  const turnDir = join(dir, 'turns', session);
  // When the current turn started: files changed after it by any means (Bash included) join the review.
  const startPath = join(dir, `turnstart-${session}.json`);

  if (kind === 'post-tool') {
    const ts = Date.now();
    const edits = editsFromToolInput(input.tool_name, input.tool_input).map(e => ({ ...e, file: resolve(shellCwd, e.file), ts }));
    if (!edits.length) return;
    mkdirSync(turnDir, { recursive: true });
    writeJson(join(turnDir, `${String(ts).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`), { edits });
    return;
  }

  if (kind === 'stop') {
    const parts = listJson(turnDir).sort();
    const edits = parts.flatMap(p => readJson(p)?.edits || []);
    const since = readJson(startPath)?.ts;
    writeJson(startPath, { ts: Date.now() });            // a continued turn (deliver: 'stop') starts here
    if (since) {
      const seen = new Set(edits.map(e => e.file));
      for (const file of changedSince(cwd, since)) {
        if (seen.has(file)) continue;
        try { edits.push({ file, tool: 'scan', before: null, after: readFileSync(file, 'utf8'), ts: Date.now() }); } catch {}
      }
    }
    if (!edits.length) return;
    const id = `${Date.now().toString(36)}-${session.slice(0, 8)}`;
    const jobPath = join(dir, 'jobs', `${id}.json`);
    writeJson(jobPath, { id, session, cwd, task: lastUserText(input.transcript_path), edits });
    for (const p of parts) { try { unlinkSync(p); } catch {} }
    if (cfg.deliver === 'stop') {
      // Synchronous mode: review now and, if defects are confirmed, keep Claude working on them in the
      // same turn instead of waiting for the next prompt. Needed for headless runs, which have no next prompt.
      await runJob(jobPath);
      const got = collect(dir, session, cfg);
      if (got) refreshDashboard(cwd, cfg);             // delivery changed what the dashboard shows
      if (got?.additionalContext) out({ decision: 'block', reason: got.additionalContext, systemMessage: got.systemMessage });
      else if (got) out({ systemMessage: got.systemMessage });
      return;
    }
    const child = spawn(process.execPath, [SELF, 'worker', jobPath], { cwd, detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
    return;
  }

  if (kind === 'prompt' || kind === 'session') {
    if (kind === 'prompt' || !readJson(startPath)) writeJson(startPath, { ts: Date.now() });
    const got = collect(dir, session, cfg);
    // Delivery changed what the dashboard shows: rewrite it in the background, off the prompt's path.
    if (got && existsSync(dashboardPath(cwd))) spawn(process.execPath, [SELF, 'dashboard', cwd, '--refresh'], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    // Config problems are shown once per session, when it starts.
    const warn = kind === 'session' ? cfg.warnings.map(w => `polywatch config: ${w}`) : [];
    // What polywatch costs, once per machine, before anything is spent.
    if (kind === 'session') { const notice = firstRunNotice(cfg); if (notice) warn.unshift(notice); }
    if (!got && !warn.length) return;
    const eventName = kind === 'prompt' ? 'UserPromptSubmit' : 'SessionStart';
    const o = { systemMessage: [...warn, got?.systemMessage].filter(Boolean).join('\n') };
    if (got?.additionalContext) o.hookSpecificOutput = { hookEventName: eventName, additionalContext: got.additionalContext };
    out(o);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'hook') return await hook(args[0]);
    if (cmd === 'worker') { await runJob(args[0]); return; }
    if (cmd === 'report') {
      const cwd = args[0] ? resolve(args[0]) : projectRoot(process.cwd());
      const dir = stateDir(cwd);
      const rs = listJson(join(dir, 'results')).map(p => readJson(p)).filter(Boolean).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
      console.log(renderReport(rs.slice(-(Number(process.env.POLYWATCH_LAST) || 10))));
      return;
    }
    if (cmd === 'review') {
      // Manual review of files as if they were written in one turn: polywatch review <file>... [--task "..."]
      const cwd = process.cwd(); const dir = stateDir(cwd);
      const ti = args.indexOf('--task'); const task = ti >= 0 ? args[ti + 1] : null;
      const files = ti >= 0 ? args.filter((a, i) => i !== ti && i !== ti + 1) : args;
      const id = `${Date.now().toString(36)}-manual`;
      const jobPath = join(dir, 'jobs', `${id}.json`);
      writeJson(jobPath, { id, session: 'manual', cwd, task, edits: files.map(f => ({ file: resolve(cwd, f), tool: 'Write', before: null, after: readFileSync(f, 'utf8') })) });
      const r = await runJob(jobPath);
      console.log(renderReport([r]));
      return;
    }
    if (cmd === 'outcome') {
      // Record whether a shown finding was real: polywatch outcome <reviewId> <findingNumber> real|false [note]
      // --by claude|<name> records who judged it (default: user); --dir names the project when run from elsewhere.
      const opt = (k) => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
      const by = opt('--by') || 'user', dirOpt = opt('--dir');
      const [id, num, verdict, ...note] = args;
      if (!id || !(+num >= 1) || !['real', 'false'].includes(verdict)) throw new Error('usage: polywatch outcome <reviewId> <findingNumber> real|false [--by claude] [--dir <project>] [note]');
      const outRoot = dirOpt ? resolve(dirOpt) : projectRoot(process.cwd());
      appendJsonl(join(stateDir(outRoot), 'ledger.jsonl'), { kind: 'finding-outcome', id, index: +num, verdict, by, note: note.join(' '), at: new Date().toISOString() });
      console.log(`recorded: finding ${num} of ${id} was ${verdict === 'real' ? 'a real defect' : 'a false alarm'}`);
      refreshDashboard(outRoot, loadConfig(outRoot));
      return;
    }
    if (cmd === 'dashboard') {
      // polywatch dashboard [dir] [--no-open]: write .polywatch/dashboard.html and open it. From then on
      // polywatch keeps it current. --refresh: only rewrite an existing one (used by the hooks).
      const flags = args.filter(a => a.startsWith('--')), dirArg = args.find(a => !a.startsWith('--'));
      const root = dirArg ? resolve(dirArg) : projectRoot(process.cwd());
      const cfg = loadConfig(root);
      if (flags.includes('--refresh')) { refreshDashboard(root, cfg); return; }
      stateDir(root);
      const p = writeDashboard(root, cfg);
      console.log(`polywatch dashboard: ${p} (reloads every 10 s; polywatch keeps it current)`);
      if (!flags.includes('--no-open')) openInBrowser(p);
      return;
    }
    if (cmd === 'stats') {
      const { stats, renderStats } = await import('../src/stats.mjs');
      console.log(renderStats(stats(args[0] ? resolve(args[0]) : projectRoot(process.cwd()))));
      return;
    }
    if (cmd === 'calibration') {
      const { calibration } = await import('../src/rank.mjs');
      for (const [b, v] of Object.entries(calibration(stateDir(projectRoot(process.cwd()))))) console.log(`${b.padEnd(18)} real ${Math.round(v.precision * 100)}%  (${v.outcomes} outcomes)`);
      return;
    }
    console.log('usage: polywatch hook <post-tool|stop|prompt|session> | worker <job> | report [dir] | review <files...> [--task "..."] | outcome <id> <n> real|false | stats [dir] | dashboard [dir] [--no-open] | calibration');
  } catch (e) {
    // Hooks must never break the session: log and exit 0.
    try { appendJsonl(join(stateDir(projectRoot(process.cwd())), 'errors.jsonl'), { at: new Date().toISOString(), cmd, error: String(e.stack || e) }); } catch {}
    if (cmd !== 'hook' && cmd !== 'worker') { console.error(String(e.message || e)); process.exitCode = 1; }
  }
}
main();
