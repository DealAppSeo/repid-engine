/**
 * S-SPINE Phase 4 — public provider listing for the TrustChat selector.
 *
 * GET /providers → the LLM providers the platform can route to, with `available` reflecting
 * whether the API key is configured in this environment. (A per-request live ping would be
 * rate-limit-prone — see the strictness-2 analysis — so `available` = key present, which is the
 * honest, cheap signal. The frontend greys out unavailable providers.)
 *
 * NOTE: the actual /chat provider selection lives in the trustchat-backend repo (which already
 * accepts byok_provider + model_preference). repid-engine's routed completion is
 * /api/v1/llm/complete (ANFIS tier routing). This endpoint just advertises capability.
 *
 * Mounted BEFORE authMiddleware (public).
 */
import { Router, Request, Response } from 'express';

const router = Router();

interface ProviderDef { id: string; name: string; company: string; env: string; default_model: string }

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', name: 'Claude', company: 'Anthropic', env: 'ANTHROPIC_API_KEY', default_model: 'claude-3-5-sonnet' },
  { id: 'openai', name: 'GPT-4o', company: 'OpenAI', env: 'OPENAI_API_KEY', default_model: 'gpt-4o' },
  { id: 'groq', name: 'Llama 3.x', company: 'Groq', env: 'GROQ_API_KEY', default_model: 'llama-3.3-70b-versatile' },
  { id: 'cerebras', name: 'Cerebras', company: 'Cerebras', env: 'CEREBRAS_API_KEY', default_model: 'llama3.1-8b' },
  { id: 'fireworks', name: 'Fireworks', company: 'Fireworks AI', env: 'FIREWORKS_API_KEY', default_model: 'kimi-k2p5' },
  { id: 'gemini', name: 'Gemini', company: 'Google', env: 'GEMINI_API_KEY', default_model: 'gemini-1.5-pro' },
  { id: 'deepseek', name: 'DeepSeek', company: 'DeepSeek', env: 'DEEPSEEK_API_KEY', default_model: 'deepseek-chat' },
  { id: 'cohere', name: 'Command', company: 'Cohere', env: 'COHERE_API_KEY', default_model: 'command-r-plus' },
];

function isAvailable(p: ProviderDef): boolean {
  // gemini may be keyed as GEMINI_API_KEY or GOOGLE_API_KEY
  if (p.id === 'gemini') return !!(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
  return !!process.env[p.env]?.trim();
}

router.get('/providers', (_req: Request, res: Response) => {
  const providers = PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    company: p.company,
    default_model: p.default_model,
    available: isAvailable(p),
  }));
  res.json({
    providers,
    available_count: providers.filter((p) => p.available).length,
    note: 'available = API key configured in this environment; not a live health ping',
    last_updated: new Date().toISOString(),
  });
});

// Exported for tests.
export const __providers = PROVIDERS;
export default router;
