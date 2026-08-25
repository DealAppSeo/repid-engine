/**
 * S-FIX Phase 2 — HAL completeness check.
 *
 * The 5 HAL signals check whether claims are SUPPORTED, not whether the answer is COMPLETE.
 * (E.g. "the capital of California" answered "Sacramento" omits the 1862 SF interim capital.)
 * This adds an opt-in 6th dimension: does the answer cover the major aspects of the question?
 *
 * Gated by HAL_COMPLETENESS=true and OFF by default — it costs one extra (free-tier) LLM call per
 * eval and the default HAL score formula is NOT changed here (wiring it into the weighted score
 * needs recalibration; see docs). The LLM call is injectable so this is unit-testable offline.
 *
 * Returns a 0..1 completeness score (1 = fully covers; low = significant omissions).
 */
export type LlmFn = (prompt: string) => Promise<string>;

export function isCompletenessEnabled(): boolean {
  return process.env.HAL_COMPLETENESS === 'true';
}

const COMPLETENESS_PROMPT = (q: string, a: string) =>
  `Question: "${q.slice(0, 1500)}"\nAnswer: "${a.slice(0, 3000)}"\n\n` +
  `Rate how COMPLETE the answer is (does it cover the major aspects; are there significant ` +
  `omissions?). Reply with ONLY an integer 0-100.`;

/** Parse the first 0–100 integer from model output → 0..1, default 0.5 if unparseable. */
export function parseCompleteness(text: string): number {
  const m = String(text ?? '').match(/\b(100|[0-9]{1,2})\b/);
  if (!m) return 0.5;
  return Math.max(0, Math.min(1, Number(m[1]) / 100));
}

/**
 * @param callLLM optional injected LLM (defaults to a free groq call). Returns 0..1; never throws —
 * on any failure returns 0.5 (neutral) so a completeness hiccup can't break HAL.
 */
export async function checkCompleteness(prompt: string, response: string, callLLM?: LlmFn): Promise<number> {
  if (!prompt || !response) return 0.5;
  try {
    const fn = callLLM ?? defaultGroqCall;
    const out = await fn(COMPLETENESS_PROMPT(prompt, response));
    return parseCompleteness(out);
  } catch {
    return 0.5;
  }
}

async function defaultGroqCall(prompt: string): Promise<string> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error('GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.HAL_S2_GROQ_MODEL ?? 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8, temperature: 0,
    }),
  });
  const d: any = await res.json();
  return d?.choices?.[0]?.message?.content ?? '';
}
