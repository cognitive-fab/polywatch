// A model call through the Claude Code CLI (`claude -p`) instead of the API, so it runs on the user's
// Claude plan and needs no API key. The call is made as bare as the CLI allows:
//   --safe-mode        no CLAUDE.md, plugins, hooks or MCP servers (so polywatch cannot review itself)
//   --tools ""         no tools: the model can only answer, never act on what the prompt quotes
//   --system-prompt    a one-line system prompt instead of Claude Code's own (about 600 tokens in all)
//   --no-session-persistence, and a temp folder as cwd, so nothing is written into the project
// ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and the Bedrock/Vertex/Foundry switches are
// removed from the child's environment: with any of them set, Claude Code does not use the plan login.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';

const SYSTEM = 'You review code for defects and check claims about code. Answer exactly in the format the message asks for.';

// POLYWATCH_CLAUDE_CMD (a JSON array of strings, e.g. ["node","fake.mjs"]) replaces the `claude` executable; used by tests.
// On Windows, spawn without a shell runs only .exe files: the native installer's claude.exe works as is,
// while an npm install is a claude.cmd shim, so its cli.js is run with this Node instead.
function command() {
  try { const c = JSON.parse(process.env.POLYWATCH_CLAUDE_CMD || 'null'); if (Array.isArray(c) && c.length && c.every(x => typeof x === 'string' && x)) return c; } catch {}
  if (process.platform !== 'win32') return ['claude'];
  for (const d of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(d, 'claude.exe'))) return [join(d, 'claude.exe')];
    const shim = join(d, 'claude.cmd');
    if (existsSync(shim)) {
      // npm's shim runs "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" (or %~dp0 in older ones).
      const m = readFileSync(shim, 'utf8').match(/%~?dp0%?\\([^"\r\n]*cli\.m?js)/i);
      if (m) { const js = join(d, m[1]); if (existsSync(js)) return [process.execPath, js]; }
    }
  }
  return ['claude'];
}

// Variables that make Claude Code use API credentials or another provider instead of the plan login.
const NOT_THE_PLAN = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

export function callClaudeCode({ model, prompt, timeoutMs = 600000 }) {
  const [cmd, ...pre] = command();
  const args = [...pre, '-p', '--safe-mode', '--tools', '', '--no-session-persistence', '--system-prompt', SYSTEM, '--output-format', 'json', ...(model ? ['--model', model] : [])];
  const env = { ...process.env }; for (const k of [...NOT_THE_PLAN, 'CLAUDE_PROJECT_DIR']) delete env[k];
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '', err = '', settled = false, timer = null;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let c;
    try { c = spawn(cmd, args, { cwd: tmpdir(), env, windowsHide: true }); }
    catch (e) { return done({ error: `claude -p could not start (${e.code || e.message})` }); }
    timer = setTimeout(() => { c.kill(); done({ error: `claude -p timed out after ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('error', e => done({ error: `claude -p could not start (${e.code || e.message}); is Claude Code on PATH?` }));
    c.on('close', (code) => {
      let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch {}
      if (!j) return done({ error: `claude -p exited ${code}: ${(err || out).trim().slice(0, 300)}` });
      if (j.is_error) return done({ error: `claude -p: ${String(j.result || j.terminal_reason || 'error').slice(0, 300)}` });
      // total_cost_usd is the list price of the tokens; on a plan it measures usage, not money spent.
      done({ text: String(j.result ?? ''), usage: j.usage || {}, finish: j.stop_reason, usd: j.total_cost_usd || 0, plan: true, seconds: (Date.now() - t0) / 1000 });
    });
    c.stdin.on('error', () => {});
    c.stdin.end(prompt);
  });
}
