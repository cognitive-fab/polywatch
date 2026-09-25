#!/usr/bin/env node
// Merge .polywatch folders that polywatch 0.2.0 left in subfolders into <project>/.polywatch.
// 0.2.0 kept state in Claude's current shell folder, so one session could spread over several.
// Usage: node scripts/merge-state.mjs <project> [--apply]   (without --apply it only lists what it would do)
import { existsSync, readdirSync, readFileSync, appendFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stateDir } from '../src/config.mjs';
import { readJson, writeJson } from '../src/util.mjs';

const [rootArg, flag] = process.argv.slice(2);
if (!rootArg) { console.error('usage: node scripts/merge-state.mjs <project> [--apply]'); process.exit(1); }
const root = resolve(rootArg), apply = flag === '--apply';
const target = join(root, '.polywatch');

function strays(d, depth = 0, out = []) {
  if (depth > 6) return out;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(d, e.name);
    if (e.name === '.polywatch') { if (d !== root) out.push(p); continue; }
    strays(p, depth + 1, out);
  }
  return out;
}

const files = (d) => existsSync(d) ? readdirSync(d) : [];
const act = (msg, fn) => { console.log((apply ? '' : '[dry run] ') + msg); if (apply) fn(); };

if (apply) stateDir(root);
for (const src of strays(root)) {
  const rel = relative(root, src);
  const busy = files(join(src, 'jobs')).filter(f => f.endsWith('.json'));
  if (busy.length) { console.log(`${rel}: ${busy.length} review(s) still running, skipped; try again later`); continue; }
  for (const f of files(join(src, 'results'))) {
    if (existsSync(join(target, 'results', f))) { console.log(`${rel}: results/${f} already in the project, kept the project's copy`); continue; }
    act(`${rel}: move results/${f}`, () => renameSync(join(src, 'results', f), join(target, 'results', f)));
  }
  for (const session of files(join(src, 'inbox'))) {
    for (const m of files(join(src, 'inbox', session))) {
      act(`${rel}: move undelivered marker ${session}/${m}`, () => { mkdirSync(join(target, 'inbox', session), { recursive: true }); renameSync(join(src, 'inbox', session, m), join(target, 'inbox', session, m)); });
    }
  }
  for (const name of ['ledger.jsonl', 'errors.jsonl']) {
    const p = join(src, name); if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    act(`${rel}: append ${text.split('\n').filter(Boolean).length} line(s) of ${name}`, () => appendFileSync(join(target, name), text.endsWith('\n') || !text ? text : text + '\n'));
  }
  for (const f of files(src).filter(f => /^state-.*\.json$/.test(f))) {
    if (!existsSync(join(target, f))) { act(`${rel}: move ${f}`, () => renameSync(join(src, f), join(target, f))); continue; }
    // Both folders tracked this session: keep the stricter fix-round count and every note already shown.
    const a = readJson(join(target, f), {}), b = readJson(join(src, f), {});
    const merged = { ...a, fixRounds: Math.max(a.fixRounds || 0, b.fixRounds || 0), notesShown: [...new Set([...(a.notesShown || []), ...(b.notesShown || [])])] };
    act(`${rel}: merge ${f} into the project's (fixRounds ${merged.fixRounds})`, () => writeJson(join(target, f), merged));
  }
  const stranded = files(join(src, 'turns')).flatMap(s => files(join(src, 'turns', s)));
  if (stranded.length) console.log(`${rel}: ${stranded.length} edit record(s) from turns that ended in another folder; they were never reviewed and are dropped`);
  act(`${rel}: remove the folder`, () => rmSync(src, { recursive: true, force: true }));
}
