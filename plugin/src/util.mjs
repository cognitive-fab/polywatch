import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, renameSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const readJson = (p, dflt = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; } };
// Unique temporary name, so two processes writing the same file never share (and lose) one.
export const writeJson = (p, v) => { const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; writeFileSync(tmp, JSON.stringify(v, null, 2)); renameSync(tmp, p); };
export const appendJsonl = (p, v) => appendFileSync(p, JSON.stringify(v) + '\n');
export const listJson = (dir) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => join(dir, f)) : [];
export const safeId = (s) => String(s || 'session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    // unref: a pending timer must not keep the hook process alive after stdin has ended.
    const t = setTimeout(() => resolve(data), 3000); t.unref();
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
  });
}

// Minimal glob: '*' within a segment, '**' across segments; matched against the path relative to cwd.
export function globToRegex(g) {
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { r += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + r + '$', 'i');
}

export function isExcluded(cwd, file, patterns) {
  const rel = relative(cwd, file).split(sep).join('/');
  const base = rel.split('/').pop();
  return patterns.some(p => { const re = globToRegex(p); return re.test(rel) || re.test(base); });
}

// Wrappers Claude Code puts around slash commands, command output and system notices: not the request.
const WRAPPER = /^<(command-|local-command-|system-reminder|task-notification|bash-|user-memory-input)/;

export function lastUserText(transcriptPath) {
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let j; try { j = JSON.parse(lines[i]); } catch { continue; }   // a half-written or corrupt line is skipped, not fatal
    if (j?.type !== 'user') continue;
    const c = j.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    // Also skip polywatch's own feedback, which comes back as a user message in deliver: 'stop' mode.
    if (text && !WRAPPER.test(text.trimStart()) && !text.includes('polywatch reviewed your last change')) return text.slice(0, 4000);
  }
  return null;
}
