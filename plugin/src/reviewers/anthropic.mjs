// Streamed Anthropic Messages API call. Streaming keeps long thinking calls alive.
// Prices per 1M tokens, captured 2026-10-07 from https://platform.claude.com/docs/en/about-claude/pricing
const PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5], 'claude-fable-5-1': [10, 50],
};
// Haiku 5.5 charges more for the whole request when the prompt is over 100,000 tokens.
const LONG = { 'claude-haiku-5-5': { over: 100000, price: [0.5, 2.5] } };
// A model missing from the table is charged at the highest known price, so the per-turn budget
// still holds; `price` ([input, output] per 1M tokens, from the user's config) overrides the table.
const MAX = Object.values(PRICES).reduce((m, p) => [Math.max(m[0], p[0]), Math.max(m[1], p[1])], [0, 0]);
const base = (model) => String(model).replace(/-\d{8}$/, '');   // dated ids share the alias's price
export const knownAnthropic = (model) => !!PRICES[base(model)];
export function priceAnthropic(model, usage, price) {
  const long = LONG[base(model)];
  const prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const p = price || (long && prompt > long.over ? long.price : PRICES[base(model)]) || MAX;
  // Cache writes cost 1.25x input; reads at most 0.1x (less on some models, so this never undercounts).
  const inputCost = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0) + 0.1 * (usage.cache_read_input_tokens || 0);
  return (inputCost * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6;
}
export async function callAnthropic({ model, apiKey, prompt, price, effort, maxTokens = 64000, timeoutMs = 900000 }) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, ...(effort && { output_config: { effort } }), messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const dec = new TextDecoder(); let buf = '', text = '', usage = {}, finish = null;
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (j.type === 'message_start') usage = { ...j.message?.usage };
        else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') text += j.delta.text;
        else if (j.type === 'message_delta') { finish = j.delta?.stop_reason ?? finish; Object.assign(usage, j.usage); }
        else if (j.type === 'error') throw new Error(`anthropic stream: ${j.error?.type || ''} ${String(j.error?.message || '').slice(0, 300)}`);
      }
    }
    return { text, usage, finish, usd: priceAnthropic(model, usage, price), unpriced: !price && !knownAnthropic(model) ? model : undefined, seconds: (Date.now() - t0) / 1000 };
  } finally { clearTimeout(t); }
}
