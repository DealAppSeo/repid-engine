import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';

/**
 * Z.AI (Zhipu) — the GLM family from the vendor, on their free tier.
 *
 * WHY THIS ADAPTER EXISTS, in one measurement. Over the last 30 days we made
 * 25,995 calls to `zai-glm-4.7` **via Cerebras** at $0.0000554 each — $1.44, which
 * is **59 % of all LLM spend** on 16 % of the volume. It is 7.3× the per-call cost
 * of groq's llama-3.1-8b.
 *
 * Z.AI publishes GLM-4.7 and GLM-4.5-Flash on a permanently free tier. So the fix
 * is not to stop using GLM — it is a good model and the routing chose it for
 * reasons. The fix is to buy it from the vendor instead of a reseller.
 *
 * That distinction matters because the earlier read of this data was "route away
 * from Cerebras", which was wrong at the provider level: Cerebras is one of the
 * fastest free providers we have and its llama models cost nothing. The expensive
 * thing was one MODEL on it, and the cheap source for that model already existed.
 *
 * ALSO A FAMILY, NOT JUST A PRICE. `glm` is already in KNOWN_FAMILIES, so this does
 * not widen HAL quorum on its own — but it removes the incentive to route GLM
 * through a paid path, which is what was quietly capping how often HAL could afford
 * a GLM voice in the quorum.
 *
 * The key already existed (`ZAI_API_KEY`) — this is wiring, not a new credential.
 *
 * API shape is OpenAI-compatible, so this mirrors the Cerebras adapter almost
 * exactly. Deliberately so: a provider adapter that invents its own conventions is
 * a provider adapter nobody can audit against its siblings.
 */
export class ZaiAdapter implements ProviderAdapter {
  name = 'zai';
  tier: 0 | 1 = 0;
  free = true;

  /**
   * Free-tier default is the FLASH model.
   *
   * GLM-4.7 is also free but rate-limits harder; Flash is the one that survives a
   * continuous agent loop. A caller that specifically wants 4.7 asks for it, and
   * the router's fallback covers the 429.
   */
  static readonly DEFAULT_MODEL = 'glm-4.5-flash';

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || ZaiAdapter.DEFAULT_MODEL;
    const timeout = req.timeout || 30000;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${req.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens,
          temperature: req.temperature
        }),
        signal: controller.signal
      });
    } catch (e: any) {
      clearTimeout(id);
      throw new Error(`Z.AI fetch error: ${e.message}`);
    }
    clearTimeout(id);

    if (res.status === 401 || res.status === 403) throw new AuthError('Z.AI auth failed');
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const retryMs = retry ? parseInt(retry) * 1000 : 10000;
      throw new RateLimitError('Z.AI rate limited', retryMs);
    }
    if (!res.ok) throw new Error(`Z.AI HTTP error: ${res.status}`);

    const data = await res.json();
    return {
      answer: data.choices?.[0]?.message?.content || '',
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      latencyMs: Date.now() - startTime,
      provider: this.name,
      model,
      rawResponse: data
    };
  }
}
