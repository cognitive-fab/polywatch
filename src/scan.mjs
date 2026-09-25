// Files changed during a turn by means other than Edit/Write/MultiEdit: Bash heredocs, sed -i, scripts,
// formatters. Claude often writes code through Bash, which the PostToolUse hook never sees.
// Source files modified since the turn started are found by mtime; in a git repository the candidates
// come from git (tracked-and-modified plus untracked, .gitignore respected), elsewhere from a bounded walk.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const SOURCE = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.rs', '.go', '.java', '.kt', '.scala', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.sh', '.ps1', '.lua', '.jl', '.sql', '.vue', '.svelte', '.html']);
const SKIP = new Set(['node_modules', '.git', '.polywatch', 'target', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv', '.next', '.cache', 'coverage', 'vendor']);
const MAX_WALK = 20000, MAX_FILES = 20;

function candidates(root, since) {
  if (existsSync(join(root, '.git'))) {
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
    const r = git(['ls-files', '-m', '-o', '--exclude-standard', '-z']);
    if (r.status === 0) {
      // Files Claude committed during the turn are no longer "modified": take them from the commits.
      const c = git(['log', `--since=${new Date(since).toISOString()}`, '--name-only', '--format=', '-z']);
      const committed = c.status === 0 ? c.stdout.split(/[\0\n]/).filter(Boolean) : [];
      // -m lists only unstaged changes: staged ones (git add, new files included) come from the index.
      const s = git(['diff', '--cached', '--name-only', '-z']);
      const staged = s.status === 0 ? s.stdout.split('\0').filter(Boolean) : [];
      return [...new Set([...r.stdout.split('\0').filter(Boolean), ...committed, ...staged])].map(f => join(root, f));
    }
  }
  const out = [], stack = [[root, 0]]; let seen = 0;
  while (stack.length && seen < MAX_WALK) {
    const [d, depth] = stack.pop();
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > MAX_WALK) break;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.') && depth < 8) stack.push([join(d, e.name), depth + 1]); }
      else if (e.isFile()) out.push(join(d, e.name));
    }
  }
  return out;
}

// Source files under root modified after `since` (ms), newest first, at most MAX_FILES.
export function changedSince(root, since) {
  const hits = [];
  for (const f of candidates(root, since)) {
    if (!SOURCE.has(extname(f).toLowerCase())) continue;
    let st; try { st = statSync(f); } catch { continue; }
    if (st.isFile() && st.mtimeMs > since) hits.push({ f, t: st.mtimeMs });
  }
  return hits.sort((a, b) => b.t - a.t).slice(0, MAX_FILES).map(h => h.f);
}
