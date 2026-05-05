/**
 * Phase 4 extraction target — STUB. Real implementation at
 * src/hal/cross-llm-client.ts:454. Library version will accept providers
 * + embedding client via DI rather than reading process.env.* directly.
 */
import type { CrossLLMSummary, HALEmbeddingClient, HALProviderConfig } from '../types';

export interface CrossLLMOptions {
  providers: HALProviderConfig[];
  embeddingClient?: HALEmbeddingClient | null;
  supabase?: unknown | null;
  timeoutMs?: number;
}

export async function checkCrossLLM(_prompt: string, _opts: CrossLLMOptions): Promise<CrossLLMSummary> {
  throw new Error('cross-llm.checkCrossLLM not yet implemented — Phase 4 of HAL extraction sprint');
}
