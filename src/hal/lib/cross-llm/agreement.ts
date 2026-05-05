/**
 * Pure helpers for cross-LLM agreement computation. No I/O, no env reads.
 *
 * Ported from src/hal/cross-llm-client.ts:227-373 with no semantic change.
 * The Pythagorean Comma BFT severity tiers are imported from the central
 * constants module so the patent-load-bearing thresholds are single-sourced.
 */
import { COMMA_BFT_THRESHOLDS } from '../constants';
import type { CommaSeverity, HALEmbeddingClient } from '../types';

export interface PairwiseSimilarityInput {
  texts: string[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function jaccardSimilarity(a: string, b: string): number {
  const tok = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1),
  );
  const sa = tok(a), sb = tok(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Pythagorean Comma BFT veto check (P-003).
 * Pure — no allocations beyond the result object.
 *
 * Severity tiers (constants from COMMA_BFT_THRESHOLDS):
 *   - critical: gap < vetoGap (0.05) AND avg > vetoAvg (0.85) → VETO
 *   - major:    gap < majorGap (0.10) AND avg > majorAvg (0.75) → log only
 *   - minor:    gap < minorGap (0.15) → log only
 *   - none:     otherwise → healthy SBFA divergence
 *
 * Veto requires >= 3 beliefs; with 2 the gap is meaningless.
 */
export function checkPythagoreanComma(beliefs: number[]): {
  severity: CommaSeverity;
  comma_gap: number | null;
  comma_veto: boolean;
} {
  if (beliefs.length < 3) {
    return { severity: 'none', comma_gap: null, comma_veto: false };
  }
  const t = COMMA_BFT_THRESHOLDS;
  const gap = Math.max(...beliefs) - Math.min(...beliefs);
  const avg = beliefs.reduce((s, b) => s + b, 0) / beliefs.length;
  if (gap < t.vetoGap && avg > t.vetoAvg) {
    return { severity: 'critical', comma_gap: gap, comma_veto: true };
  }
  if (gap < t.majorGap && avg > t.majorAvg) {
    return { severity: 'major', comma_gap: gap, comma_veto: false };
  }
  if (gap < t.minorGap) {
    return { severity: 'minor', comma_gap: gap, comma_veto: false };
  }
  return { severity: 'none', comma_gap: gap, comma_veto: false };
}

export async function getEmbedding(
  text: string, client: HALEmbeddingClient,
): Promise<number[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs ?? 10000);
  try {
    const res = await fetch(client.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${client.apiKey}`,
      },
      body: JSON.stringify({ model: client.model, input: text }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embedding ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const vec: number[] = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('empty embedding vector');
    }
    return vec;
  } finally {
    clearTimeout(timer);
  }
}

export interface AgreementResult {
  beliefs: number[];
  meanAgreement: number;
  methodology: 'embedding-cosine' | 'fallback-jaccard';
}

/**
 * Compute per-provider beliefs and mean agreement from a list of answered
 * provider texts. Embedding client is optional — when null/undefined, falls
 * back to Jaccard token overlap.
 *
 * b_i = mean(sim(answer_i, answer_j) for j != i)
 * meanAgreement = mean of all pairwise similarities = mean of beliefs
 *   (algebraically equivalent for full pairs)
 */
export async function computeAgreement(
  answered: { idx: number; text: string }[],
  embeddingClient?: HALEmbeddingClient | null,
): Promise<AgreementResult> {
  const n = answered.length;
  if (n < 2) {
    return { beliefs: [], meanAgreement: 0, methodology: 'fallback-jaccard' };
  }

  let methodology: 'embedding-cosine' | 'fallback-jaccard' = 'fallback-jaccard';
  let embeddings: number[][] | null = null;

  if (embeddingClient) {
    try {
      embeddings = await Promise.all(
        answered.map(a => getEmbedding(a.text, embeddingClient)),
      );
      methodology = 'embedding-cosine';
    } catch (e: any) {
      console.error('[hal/lib/cross-llm] embedding fallback:', e?.message ?? e);
      embeddings = null;
    }
  }

  const sims: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = embeddings
        ? cosineSimilarity(embeddings[i]!, embeddings[j]!)
        : jaccardSimilarity(answered[i]!.text, answered[j]!.text);
      sims[i]![j] = s;
      sims[j]![i] = s;
    }
  }

  const beliefs: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) if (j !== i) sum += sims[i]![j]!;
    beliefs.push(sum / (n - 1));
  }

  const meanAgreement = beliefs.length === 0
    ? 0
    : beliefs.reduce((s, b) => s + b, 0) / beliefs.length;

  return { beliefs, meanAgreement, methodology };
}
