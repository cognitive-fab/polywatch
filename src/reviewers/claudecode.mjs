// A model call through the Claude Code CLI (`claude -p`) instead of the API, so it runs on the user's
// Claude plan and needs no API key. The call is made as bare as the CLI allows:
//   --safe-mode        no CLAUDE.md, plugins, hooks or MCP servers (so polywatch cannot review itself)
//   --tools ""         no tools: the model can only answer, never act on what the prompt quotes
//   --system-prompt    a one-line system prompt instead of Claude Code's own (about 600 tokens in all)
//   --no-session-persistence, and a temp folder as cwd, so nothing is written into the project
// ANTHROPIC_API_KEY is removed from the child's environment: with it set, Claude Code bills the API
// account instead of the plan.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const SYSTEM = 'You review code for defects and check claims about code. Answer exactly in the format the message asks for.';

// POLYWATCH_CLAUDE_CMD (a JSON array, e.g. ["node","fake.mjs"]) replaces the `claude` executable; used by tests.
const command = () => { try { const c = JSON.parse(process.env.POLYWATCH_CLAUDE_CMD || 'null'); if (Array.isArray(c) && c.length) return c; } catch {} return ['claude']; };

export function callClaudeCode({ model, prompt, timeoutMs = 600000 }) {
  const [cmd, ...pre] = command();
  const args = [...pre, '-p', '--safe-mode', '--tools', '', '--no-session-persistence', '--system-prompt', SYSTEM, '--output-format', 'json', ...(model ? ['--model', model] : [])];
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_PROJECT_DIR;
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const c = spawn(cmd, args, { cwd: tmpdir(), env, windowsHide: true });
    const timer = setTimeout(() => { c.kill(); done({ error: `claude -p timed out after ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
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
