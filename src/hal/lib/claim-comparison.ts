/**
 * Wave 5 Phase 3 — consensus-vs-claim comparison.
 *
 * The missing veto layer that compares the LLM consensus answer to the
 * user's claim text. Triggered at strictness level 4+ when the cross-LLM
 * agreement is "in-band" (Phase 4 zone classification).
 *
 * Architectural note (Phase 5 finding addressed): the original Pythagorean
 * Comma BFT measures provider-vs-provider agreement, NOT provider-vs-claim.
 * When 3 providers correctly contradict a user fabrication with varied
 * prose, BFT can't see it because the providers all agree with each other.
 * This module fills that gap: it picks a representative consensus answer
 * and compares it directly against the user's claim text.
 */
import { cosineSimilarity } from './cross-llm/agreement';
import { semanticPairSimilarity } from './semantic';
import type { HALEmbeddingClient } from './types';

/**
 * Default contradiction threshold. If similarity(claim, consensus) is
 * BELOW this number, the claim is considered to contradict the consensus.
 * Calibrated for cosine on sentence-transformer embeddings; with the
 * Jaccard fallback this threshold is appropriate too because most
 * claim-vs-correct-consensus pairs share little surface vocabulary.
 *
 * Initial value: 0.4. Future federated-learning sprint refines.
 */
export const CLAIM_CONTRADICTION_THRESHOLD = 0.4;

export interface ConsensusToClaimInput {
  claim: string;
  /** Provider responses that already passed the in-band consensus check. */
  responses: string[];
  embeddingClient?: HALEmbeddingClient | null;
  /** Override default threshold for ablation studies. */
  contradictionThreshold?: number;
  /** Pre-computed embeddings for `responses` (parallel array). Optional. */
  responseEmbeddings?: number[][];
}

export interface ConsensusToClaimResult {
  consensus_answer: string;
  similarity: number;
  contradicts: boolean;
  threshold: number;
  /** Strength of the contradiction signal in [0, 1]. */
  confidence: number;
  methodology: 'embedding-cosine' | 'fallback-jaccard';
}

/**
 * Pick the consensus answer from a list of responses. When embeddings
 * are available, use the response whose embedding is closest to the
 * centroid (median-embedding pick — reduces influence of outliers).
 * Otherwise pick the longest response (most detail / token surface).
 */
function pickConsensus(
  responses: string[],
  embeddings?: number[][],
): { answer: string; index: number } {
  if (responses.length === 0) {
    return { answer: '', index: -1 };
  }
  if (responses.length === 1) {
    return { answer: responses[0]!, index: 0 };
  }

  if (embeddings && embeddings.length === responses.length) {
    // Compute centroid and pick the response closest to it.
    const dim = embeddings[0]!.length;
    const centroid = new Array<number>(dim).fill(0);
    for (const v of embeddings) {
      for (let i = 0; i < dim; i++) centroid[i]! += v[i] ?? 0;
    }
    for (let i = 0; i < dim; i++) centroid[i]! /= embeddings.length;

    let bestIdx = 0;
    let bestSim = -Infinity;
    for (let i = 0; i < embeddings.length; i++) {
      const s = cosineSimilarity(embeddings[i]!, centroid);
      if (s > bestSim) {
        bestSim = s;
        bestIdx = i;
      }
    }
    return { answer: responses[bestIdx]!, index: bestIdx };
  }

  // Fallback: longest response wins.
  let bestIdx = 0;
  let bestLen = -1;
  for (let i = 0; i < responses.length; i++) {
    if (responses[i]!.length > bestLen) {
      bestLen = responses[i]!.length;
      bestIdx = i;
    }
  }
  return { answer: responses[bestIdx]!, index: bestIdx };
}

/**
 * Compare the user's claim to the LLM consensus. When cosine(claim,
 * consensus) is below `contradictionThreshold`, the claim contradicts
 * the consensus → caller should set vetoed=true at strictness 4+.
 *
 * Confidence is derived as 1 - (similarity / threshold) clamped to [0,1]
 * — a strongly contradictory claim (similarity ≈ 0) yields confidence ≈ 1.
 */
export async function compareConsensusToClaim(
  input: ConsensusToClaimInput,
): Promise<ConsensusToClaimResult | null> {
  if (!input.responses || input.responses.length === 0) return null;

  const threshold =
    typeof input.contradictionThreshold === 'number'
      ? input.contradictionThreshold
      : CLAIM_CONTRADICTION_THRESHOLD;

  const { answer: consensusAnswer } = pickConsensus(
    input.responses,
    input.responseEmbeddings,
  );

  const pair = await semanticPairSimilarity(
    input.claim,
    consensusAnswer,
    input.embeddingClient,
  );

  const contradicts = pair.similarity < threshold;
  const confidence = contradicts
    ? Math.max(0, Math.min(1, 1 - pair.similarity / threshold))
    : 0;

  return {
    consensus_answer: consensusAnswer,
    similarity: pair.similarity,
    contradicts,
    threshold,
    confidence,
    methodology: pair.methodology,
  };
}

export { pickConsensus as _pickConsensusForTest };
