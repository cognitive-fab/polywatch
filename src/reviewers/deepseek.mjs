// Streamed DeepSeek call (OpenAI-compatible). Streaming keeps long reasoning calls alive.
// Prices per 1M tokens, captured 2026-09-23 from https://api-docs.deepseek.com/quick_start/pricing
const PRICES = {
  'deepseek-flash': { off: [0.003, 0.15, 0.6], peak: [0.006, 0.3, 1.2] },
  'deepseek-v4-pro': { off: [0.022, 0.66, 1.98], peak: [0.044, 1.32, 3.96] },
};
function isPeak(d = new Date()) {
  const day = d.getUTCDay(), h = d.getUTCHours();
  if (day === 0 || day === 6) return false;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
// A model missing from the table is charged at the highest known price, so the per-turn budget
// still holds; `price` ([input, output] per 1M tokens, from the user's config) overrides the table.
const MAX = Object.values(PRICES).flatMap(p => [p.off, p.peak]).reduce((m, p) => m.map((x, i) => Math.max(x, p[i])), [0, 0, 0]);
export const knownDeepseek = (model) => !!PRICES[model];
export function priceDeepseek(model, usage, price) {
  const p = PRICES[model];
  const [hit, miss, out] = price ? [price[0], price[0], price[1]] : p ? (isPeak() ? p.peak : p.off) : MAX;
  const pin = usage.prompt_tokens || 0, cached = usage.prompt_cache_hit_tokens || 0;
  return (cached * hit + (pin - cached) * miss + (usage.completion_tokens || 0) * out) / 1e6;
}

export async function callDeepseek({ model, baseUrl, apiKey, prompt, price, maxTokens = 64000, timeoutMs = 900000 }) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const dec = new TextDecoder(); let buf = '', text = '', usage = {}, finish = null;
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const c = j.choices?.[0];
        if (c?.delta?.content) text += c.delta.content;
        if (c?.finish_reason) finish = c.finish_reason;
        if (j.usage) usage = j.usage;
      }
    }
    return { text, usage, finish, usd: priceDeepseek(model, usage, price), unpriced: !price && !knownDeepseek(model) ? model : undefined, seconds: (Date.now() - t0) / 1000 };
  } finally { clearTimeout(t); }
}
