// Stands in for `claude -p` in tests: echoes a verdict and the flags it was given.
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  const args = process.argv.slice(2);
  const answer = input === 'echo' ? { args, keyVisible: !!process.env.ANTHROPIC_API_KEY }
    : input.startsWith('A reviewer made a specific claim') ? { holds: 'yes', evidence: 'seen by the fake' } : { issues: [] };
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(answer), total_cost_usd: 0.01, usage: {}, stop_reason: 'end_turn', args, keyVisible: !!process.env.ANTHROPIC_API_KEY }) + '\n');
});
