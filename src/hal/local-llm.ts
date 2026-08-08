/**
 * BYO / local-model base-URL resolution for the HAL quorum.
 *
 * OpenAI-compatible servers (Ollama, vLLM, llama.cpp, LM Studio, LiteLLM) all
 * expose `<base>/chat/completions`. When LOCAL_LLM_BASE_URL (or OPENAI_BASE_URL)
 * is set, every openai-compat HAL provider should target that base instead of
 * api.groq.com / api.deepseek.com / api.* — that is the single switch that lets
 * the quorum run against a model on the operator's own box.
 *
 * Pure + default-OFF: with no override this returns the provider's own default
 * endpoint unchanged, so hosted behavior is byte-identical.
 *
 * anthropic-native providers are NOT redirected here — Anthropic's Messages API
 * is not OpenAI-shaped, and a local OpenAI-compat server would reject it. In
 * local mode the quorum is expected to be openai-compat providers pointed at the
 * local base (a local server can host several model names on one endpoint).
 */

/**
 * Turn an OpenAI-compatible BASE url into the chat-completions endpoint.
 * Idempotent: if the caller already passed a full `.../chat/completions` URL it
 * is returned as-is.
 *
 *   http://localhost:11434/v1        -> http://localhost:11434/v1/chat/completions
 *   http://localhost:11434/v1/       -> http://localhost:11434/v1/chat/completions
 *   http://localhost:8000            -> http://localhost:8000/chat/completions
 *   http://x/v1/chat/completions     -> unchanged
 */
export function toChatCompletionsEndpoint(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * Resolve the endpoint an openai-compat provider should call.
 *
 * @param defaultEndpoint  the provider's own cloud endpoint (used when no override)
 * @param baseOverride     LOCAL_LLM_BASE_URL / OPENAI_BASE_URL, '' when unset
 * @param callType         only 'openai-compat' is redirected; others pass through
 */
export function resolveProviderEndpoint(
  defaultEndpoint: string,
  baseOverride: string,
  callType: 'openai-compat' | 'anthropic-native',
): string {
  if (callType !== 'openai-compat') return defaultEndpoint;
  const base = (baseOverride || '').trim();
  if (!base) return defaultEndpoint;
  return toChatCompletionsEndpoint(base);
}
