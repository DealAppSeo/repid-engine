/**
 * Provider host registry — the one place business logic may learn a provider URL.
 *
 * Host literals for business logic. Type-A files import these so they stop
 * matching the hostname grep. Type-B live fetches (HYP-10) also import them and
 * call through providerFetch. Does not honour LOCAL_LLM_BASE_URL (HYP-11) or
 * change who presents a Bearer.
 *
 * Naming every provider host IS this file's job, the same way naming its own
 * host is an adapter's job. The hostname guard pins it as REGISTRY, allowed to
 * stay. Adapters under src/providers/ keep their own literals; they are not
 * migrated here.
 *
 * Two DeepSeek paths are both here because both are live: fact-check dials
 * `/chat/completions`, the judge and cross-llm dial `/v1/chat/completions`.
 * Collapsing them would be a behaviour change, which this slice refuses.
 */

export const PROVIDER_URLS = {
  groqChatCompletions: 'https://api.groq.com/openai/v1/chat/completions',
  cerebrasChatCompletions: 'https://api.cerebras.ai/v1/chat/completions',
  openaiChatCompletions: 'https://api.openai.com/v1/chat/completions',
  openaiEmbeddings: 'https://api.openai.com/v1/embeddings',
  anthropicMessages: 'https://api.anthropic.com/v1/messages',
  deepseekChatCompletions: 'https://api.deepseek.com/chat/completions',
  deepseekV1ChatCompletions: 'https://api.deepseek.com/v1/chat/completions',
  fireworksChatCompletions: 'https://api.fireworks.ai/inference/v1/chat/completions',
  openrouterChatCompletions: 'https://openrouter.ai/api/v1/chat/completions',
  geminiOpenAiCompatChatCompletions:
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  geminiGenerateContentOrigin: 'https://generativelanguage.googleapis.com',
  mistralChatCompletions: 'https://api.mistral.ai/v1/chat/completions',
  zaiChatCompletions: 'https://api.z.ai/api/paas/v4/chat/completions',
  nvidiaNimChatCompletions: 'https://integrate.api.nvidia.com/v1/chat/completions',
  qwenDashscopeChatCompletions:
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
} as const;

/** Gemini generateContent URL. Shape copied verbatim from the former judge literal. */
export function geminiGenerateContentUrl(model: string, apiKey: string): string {
  return `${PROVIDER_URLS.geminiGenerateContentOrigin}/v1beta/models/${model}:generateContent?key=${apiKey}`;
}
