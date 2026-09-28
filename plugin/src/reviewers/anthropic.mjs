// Anthropic Messages API call. Prices per 1M tokens, captured 2026-09-23 from
// https://platform.claude.com/docs/en/about-claude/pricing
const PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5], 'claude-fable-5-1': [10, 50],
};
// A model missing from the table is charged at the highest known price, so the per-turn budget
// still holds; `price` ([input, output] per 1M tokens, from the user's config) overrides the table.
const MAX = Object.values(PRICES).reduce((m, p) => [Math.max(m[0], p[0]), Math.max(m[1], p[1])], [0, 0]);
const base = (model) => String(model).replace(/-\d{8}$/, '');   // dated ids share the alias's price
export const knownAnthropic = (model) => !!PRICES[base(model)];
export function priceAnthropic(model, usage, price) {
  const p = price || PRICES[base(model)] || MAX;
  return ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6;
}
export async function callAnthropic({ model, apiKey, prompt, price, maxTokens = 8000, timeoutMs = 600000 }) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return { text, usage: j.usage || {}, finish: j.stop_reason, usd: priceAnthropic(model, j.usage || {}, price), unpriced: !price && !knownAnthropic(model) ? model : undefined, seconds: (Date.now() - t0) / 1000 };
  } finally { clearTimeout(t); }
}
