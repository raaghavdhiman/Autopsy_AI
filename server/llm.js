// Minimal LLM provider adapter (Anthropic Messages API via fetch). Secrets stay server-side.
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.PROOFGRAPH_MODEL || 'claude-sonnet-5-5';

const status = () => ({ provider: API_KEY ? 'anthropic' : 'none', model: API_KEY ? MODEL : null, configured: !!API_KEY });

// Ask for a JSON object; returns the parsed object or throws.
async function completeJSON(system, user, { maxTokens = 4000, timeoutMs = 90000 } = {}) {
  if (!API_KEY) throw new Error('No ANTHROPIC_API_KEY configured');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${body?.error?.message || 'request failed'}`);
    const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM returned no JSON object');
    return JSON.parse(m[0]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { status, completeJSON };
