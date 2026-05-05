/**
 * Phase 4 extraction target — STUB. Real implementation at
 * src/hal/classifier.ts:156. Library version will accept a Groq client
 * via DI rather than reading process.env.GROQ_API_KEY.
 */
import type { HALProviderConfig } from './types';

export type Category = 'factual' | 'time-sensitive' | 'opinion' | 'creative' | 'task' | 'other';
export type Confidence = 'high' | 'medium' | 'low';

export interface ClassificationResult {
  category: Category;
  confidence: Confidence;
  rationale?: string;
}

export interface ClassifyOptions {
  provider: HALProviderConfig;
  supabase?: unknown | null;
  timeoutMs?: number;
}

export async function classify(_prompt: string, _opts: ClassifyOptions): Promise<ClassificationResult> {
  throw new Error('classifier.classify not yet implemented — Phase 4 of HAL extraction sprint');
}
