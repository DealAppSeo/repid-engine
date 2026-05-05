/**
 * Semantic-similarity helpers used by Wave 5 strictness layers (claim-vs-
 * consensus comparison and three-zone band classification). Pure-ish:
 * needs an embedding client to actually compute cosine. When no client
 * is provided, falls back to Jaccard token overlap so callers always get
 * a number back.
 *
 * Distinct from src/hal/lib/cross-llm/agreement.computeAgreement (which
 * computes per-provider beliefs across N LLM responses). This module is
 * the lower-level "compare two/three texts" primitive used at strictness
 * level 4+.
 */
import { cosineSimilarity, jaccardSimilarity } from './cross-llm/agreement';
import type { HALEmbeddingClient } from './types';

export interface SemanticPairResult {
  similarity: number;
  methodology: 'embedding-cosine' | 'fallback-jaccard';
}

/**
 * Compute cosine similarity between two texts using the supplied
 * embedding client. Falls back to Jaccard token overlap when:
 *   - embeddingClient is null/undefined, OR
 *   - the embedding call throws (e.g. quota / network error).
 */
export async function semanticPairSimilarity(
  a: string,
  b: string,
  embeddingClient?: HALEmbeddingClient | null,
): Promise<SemanticPairResult> {
  if (embeddingClient) {
    try {
      const [va, vb] = await embeddingClient.embedMany([a, b]);
      if (Array.isArray(va) && Array.isArray(vb) && va.length > 0 && vb.length > 0) {
        return {
          similarity: cosineSimilarity(va, vb),
          methodology: 'embedding-cosine',
        };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[hal/lib/semantic] embedding fallback:', msg);
    }
  }
  return {
    similarity: jaccardSimilarity(a, b),
    methodology: 'fallback-jaccard',
  };
}

export interface SemanticSetResult {
  pairwiseScores: number[];
  meanScore: number;
  minScore: number;
  maxScore: number;
  methodology: 'embedding-cosine' | 'fallback-jaccard';
  embeddings?: number[][];
}

/**
 * Compute pairwise similarities across a set of texts. Returns mean,
 * min, max — different threshold logic at different strictness levels
 * uses different aggregations.
 *
 * Returns `embeddings` when methodology is 'embedding-cosine' so callers
 * can reuse them for downstream operations (e.g. picking the median-
 * embedding response as the consensus answer).
 */
export async function computeSemanticSimilarity(
  texts: string[],
  embeddingClient?: HALEmbeddingClient | null,
): Promise<SemanticSetResult> {
  const n = texts.length;
  if (n < 2) {
    return {
      pairwiseScores: [],
      meanScore: n === 1 ? 1 : 0,
      minScore: n === 1 ? 1 : 0,
      maxScore: n === 1 ? 1 : 0,
      methodology: 'fallback-jaccard',
    };
  }

  let methodology: 'embedding-cosine' | 'fallback-jaccard' = 'fallback-jaccard';
  let embeddings: number[][] | null = null;
  if (embeddingClient) {
    try {
      embeddings = await embeddingClient.embedMany(texts);
      methodology = 'embedding-cosine';
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[hal/lib/semantic] embedding fallback:', msg);
      embeddings = null;
    }
  }

  const pairs: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = embeddings
        ? cosineSimilarity(embeddings[i]!, embeddings[j]!)
        : jaccardSimilarity(texts[i]!, texts[j]!);
      pairs.push(s);
    }
  }

  const sum = pairs.reduce((a, b) => a + b, 0);
  return {
    pairwiseScores: pairs,
    meanScore: sum / pairs.length,
    minScore: Math.min(...pairs),
    maxScore: Math.max(...pairs),
    methodology,
    ...(embeddings ? { embeddings } : {}),
  };
}
