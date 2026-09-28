import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastUserText } from '../plugin/src/util.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'bin', 'polywatch.mjs');
// Keep the developer's own ~/.polywatch.json and keys out of the tests.
const ENV = { ...process.env, DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', POLYWATCH_USER_CONFIG: join(tmpdir(), 'polywatch-test-no-user-config.json'), CLAUDE_PROJECT_DIR: '', POLYWATCH_SPEND_DIR: mkdtempSync(join(tmpdir(), 'pw-spend-')) };
const run = (args, input, env = {}) => spawnSync(process.execPath, [BIN, ...args], { input: JSON.stringify(input), encoding: 'utf8', env: { ...ENV, ...env } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('hooks: post-tool records, stop starts a background review, prompt delivers it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pwh-'));
  const file = join(cwd, 'a.js');
  writeFileSync(file, 'function a(x) {\n  if (x > 0) return 1;\n  return 0;\n}\n');
  const base = { session_id: 'sess-1', cwd };
  let r = run(['hook', 'post-tool'], { ...base, tool_name: 'Write', tool_input: { file_path: file, content: 'function a(x) {\n  if (x > 0) return 1;\n  return 0;\n}\n' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(join(cwd, '.polywatch', 'turns', 'sess-1')).length, 1);
  r = run(['hook', 'stop'], { ...base, stop_hook_active: false });
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 600 && readdirSync(join(cwd, '.polywatch', 'results')).length === 0; i++) await sleep(100);
  assert.equal(readdirSync(join(cwd, '.polywatch', 'results')).length, 1, 'worker produced no result');
  r = run(['hook', 'prompt'], { ...base, prompt: 'next' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.match(o.systemMessage, /polywatch: /);
  r = run(['hook', 'prompt'], { ...base, prompt: 'again' });
  assert.equal(r.stdout, '');
});

test('hooks: bad input never fails the session', () => {
  // Run from a scratch folder: the error it logs belongs there, not in this repository's .polywatch/.
  const cwd = mkdtempSync(join(tmpdir(), 'pwh-'));
  const r = spawnSync(process.execPath, [BIN, 'hook', 'stop'], { input: 'not json', encoding: 'utf8', env: ENV, cwd });
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(cwd, '.polywatch', 'errors.jsonl')), 'the error was logged somewhere else');
});

test('hooks: parallel edits are all recorded', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pwh-'));
  const base = { session_id: 'sess-p', cwd };
  const runs = Array.from({ length: 6 }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [BIN, 'hook', 'post-tool'], { stdio: ['pipe', 'ignore', 'ignore'], env: ENV });
    c.on('exit', res);
    c.stdin.end(JSON.stringify({ ...base, tool_name: 'Edit', tool_input: { file_path: join(cwd, `f${i}.js`), old_string: 'a', new_string: 'b' } }));
  }));
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0, 0, 0]);
  assert.equal(readdirSync(join(cwd, '.polywatch', 'turns', 'sess-p')).length, 6);
});

test('transcript: the request is read past a corrupt line, a leading "<" and command wrappers', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pwh-'));
  const transcript = join(cwd, 't.jsonl');
  writeFileSync(transcript, [
    { type: 'user', message: { content: 'older request' } },
    { type: 'user', message: { content: '<div> should be centered in the header' } },
    { type: 'user', message: { content: '<command-name>/foo</command-name>' } },
    { type: 'assistant', message: { content: [] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n{"type":"user","mess');
  assert.equal(lastUserText(transcript), '<div> should be centered in the header');
  assert.equal(lastUserText(join(cwd, 'missing.jsonl')), null);
});

test('hooks: state stays in the project root when Claude cds into a subfolder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pwh-'));
  const sub = join(root, 'worlds', 'jepa');
  mkdirSync(sub, { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: root };
  const base = { session_id: 'sess-r' };
  run(['hook', 'post-tool'], { ...base, cwd: root, tool_name: 'Write', tool_input: { file_path: join(sub, 'a.js'), content: 'a\nb\nc\nd\n' } }, env);
  run(['hook', 'post-tool'], { ...base, cwd: sub, tool_name: 'Edit', tool_input: { file_path: 'b.js', old_string: 'x', new_string: 'y' } }, env);
  run(['hook', 'post-tool'], { ...base, cwd: sub, tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'scratch-edit.py'), content: 'print(1)\n' } }, env);
  const parts = readdirSync(join(root, '.polywatch', 'turns', 'sess-r'));
  assert.equal(parts.length, 3);
  assert.ok(!existsSync(join(sub, '.polywatch')), 'state leaked into the subfolder');
  run(['hook', 'stop'], { ...base, cwd: sub }, env);
  for (let i = 0; i < 600 && readdirSync(join(root, '.polywatch', 'results')).length === 0; i++) await sleep(100);
  const [f] = readdirSync(join(root, '.polywatch', 'results'));
  const r = JSON.parse(readFileSync(join(root, '.polywatch', 'results', f), 'utf8'));
  assert.deepEqual(r.files, ['worlds/jepa/a.js', 'worlds/jepa/b.js'], 'relative paths resolve against the shell folder; outside files are dropped');
});

test("hooks: deliver 'stop' reviews before Claude stops and blocks with confirmed defects", async () => {
  // A local OpenAI-compatible server stands in for both the reviewer and the adjudicator.
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const prompt = JSON.parse(body).messages[0].content;
      const answer = prompt.startsWith('A reviewer made a specific claim')
        ? '{"holds":"yes","evidence":"line 2 returns 1 for zero"}'
        : JSON.stringify({ verdict: 'REJECT', issues: [{ file: 'a.js', where: 'a', severity: 'high', claim: 'returns 1 for x = 0' }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'pwh-'));
    const userCfg = join(cwd, 'user.json');
    writeFileSync(userCfg, JSON.stringify({ deliver: 'stop',
      reviewer: { provider: 'deepseek', model: 'fake', baseUrl: url, apiKeyEnv: 'FAKE_KEY', price: [0, 0] },
      adjudicator: { provider: 'deepseek', model: 'fake', baseUrl: url, apiKeyEnv: 'FAKE_KEY', price: [0, 0] } }));
    const env = { POLYWATCH_USER_CONFIG: userCfg, FAKE_KEY: 'k' };
    const base = { session_id: 'sess-s', cwd };
    const code = 'function a(x) {\n  if (x >= 0) return 1;\n  return 0;\n}\n';
    writeFileSync(join(cwd, 'a.js'), code);
    run(['hook', 'post-tool'], { ...base, tool_name: 'Write', tool_input: { file_path: join(cwd, 'a.js'), content: code } }, env);
    // spawnSync would block the event loop the fake server runs on, so the stop hook runs async here.
    const o = await new Promise((resolve) => {
      const c = spawn(process.execPath, [BIN, 'hook', 'stop'], { env: { ...ENV, ...env } });
      let s = ''; c.stdout.on('data', d => { s += d; }); c.on('exit', () => resolve(s));
      c.stdin.end(JSON.stringify(base));
    });
    const j = JSON.parse(o);
    assert.equal(j.decision, 'block');
    assert.match(j.reason, /returns 1 for x = 0/);
    assert.match(j.systemMessage, /1 finding worth a look \(1 confirmed\)/);
  } finally { server.close(); }
});

test('hooks: files written outside Edit/Write during the turn (e.g. by Bash) are reviewed too', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pwh-'));
  writeFileSync(join(cwd, 'old.py'), 'print(0)\n');                 // written before the turn: not reviewed
  const base = { session_id: 'sess-b', cwd };
  run(['hook', 'prompt'], { ...base, prompt: 'write the parser' });
  await sleep(50);
  writeFileSync(join(cwd, 'parser.py'), 'def parse(s):\n    parts = s.split(",")\n    return [int(p) for p in parts]\n');
  writeFileSync(join(cwd, 'notes.txt'), 'not source\n');
  run(['hook', 'stop'], base);
  for (let i = 0; i < 600 && readdirSync(join(cwd, '.polywatch', 'results')).length === 0; i++) await sleep(100);
  const [f] = readdirSync(join(cwd, '.polywatch', 'results'));
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.polywatch', 'results', f), 'utf8')).files, ['parser.py']);
});

test('outcome: --by and --dir record who judged it and where; the latest verdict per finding counts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pwo-'));
  const other = mkdtempSync(join(tmpdir(), 'pwo-elsewhere-'));
  const go = (...a) => spawnSync(process.execPath, [BIN, 'outcome', ...a], { cwd: other, encoding: 'utf8', env: ENV });
  assert.equal(go('r1', '1', 'real', '--by', 'claude', '--dir', cwd, 'fixed in abc').status, 0);
  assert.equal(go('r1', '1', 'false', '--dir', cwd, 'on second look, not a bug').status, 0);
  const lines = readFileSync(join(cwd, '.polywatch', 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.by, l.verdict, l.note]), [['claude', 'real', 'fixed in abc'], ['user', 'false', 'on second look, not a bug']]);
  assert.ok(!existsSync(join(other, '.polywatch', 'ledger.jsonl')), 'recorded in the wrong folder');
});
