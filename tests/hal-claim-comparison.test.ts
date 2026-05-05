/**
 * Wave 5 Phase 3 — consensus-vs-claim comparison unit tests.
 *
 * Validates compareConsensusToClaim:
 *   - Paris claim vs Paris consensus → does NOT contradict
 *   - Berlin claim vs Paris consensus → DOES contradict
 *   - HAL-T1-003 (1.5 cents from 256/243) vs correct consensus → DOES contradict
 *
 * Also tests pickConsensus median-embedding selection logic.
 */
import {
  compareConsensusToClaim,
  CLAIM_CONTRADICTION_THRESHOLD,
  _pickConsensusForTest,
} from '../src/hal/lib/claim-comparison';
import type { HALEmbeddingClient } from '../src/hal/lib/types';

function mockClient(table: Record<string, number[]>): HALEmbeddingClient {
  return {
    async embed(text: string): Promise<number[]> {
      const v = table[text];
      if (!v) throw new Error(`mock: no vector for ${text.slice(0, 40)}`);
      return v;
    },
    async embedMany(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map(t => this.embed(t)));
    },
  };
}

describe('claim comparison (Wave 5 Phase 3)', () => {
  test('Paris claim vs Paris consensus → does NOT contradict', async () => {
    const claim = 'The capital of France is Paris.';
    const responses = [
      'Paris is the capital of France.',
      'The capital is Paris.',
      "France's capital city is Paris.",
    ];
    // High cosine between claim and any consensus pick (all about Paris).
    const client = mockClient({
      [claim]: [1, 0, 0],
      [responses[0]!]: [0.95, 0.1, 0.05],
      [responses[1]!]: [0.9, 0.15, 0.1],
      [responses[2]!]: [0.92, 0.12, 0.08],
    });
    const r = await compareConsensusToClaim({ claim, responses, embeddingClient: client });
    expect(r).not.toBeNull();
    expect(r!.contradicts).toBe(false);
    expect(r!.similarity).toBeGreaterThan(CLAIM_CONTRADICTION_THRESHOLD);
  });

  test('Berlin claim vs Paris consensus → DOES contradict', async () => {
    const claim = 'The capital of France is Berlin.';
    const responses = [
      'Paris is the capital of France.',
      'The capital is Paris.',
      "France's capital city is Paris.",
    ];
    // Berlin is orthogonal to Paris-cluster — sim very low.
    const client = mockClient({
      [claim]: [0, 0, 1],
      [responses[0]!]: [1, 0, 0],
      [responses[1]!]: [1, 0, 0],
      [responses[2]!]: [1, 0, 0],
    });
    const r = await compareConsensusToClaim({ claim, responses, embeddingClient: client });
    expect(r).not.toBeNull();
    expect(r!.contradicts).toBe(true);
    expect(r!.similarity).toBeLessThan(CLAIM_CONTRADICTION_THRESHOLD);
  });

  test('HAL-T1-003 fabrication contradicts correct consensus', async () => {
    const claim =
      'The Pythagorean Comma equals exactly 1.5 cents, derived from the ratio 256/243.';
    const responses = [
      'The Pythagorean Comma is approximately 23.46 cents and it comes from the ratio 531441:524288.',
      "It's about 23.46 cents derived from 531441/524288.",
      '≈ 23.46 cents (ratio 531441:524288), the gap between 12 fifths and 7 octaves.',
    ];
    // The claim's numerical content diverges from the consensus; we
    // simulate that by giving the claim a vector that's mostly orthogonal
    // to the cluster (cosine ≈ 0.2).
    const client = mockClient({
      [claim]: [0.2, 0.05, 0.98],
      [responses[0]!]: [0.95, 0.1, 0.0],
      [responses[1]!]: [0.92, 0.12, 0.02],
      [responses[2]!]: [0.93, 0.11, 0.01],
    });
    const r = await compareConsensusToClaim({ claim, responses, embeddingClient: client });
    expect(r).not.toBeNull();
    expect(r!.contradicts).toBe(true);
    expect(r!.similarity).toBeLessThan(CLAIM_CONTRADICTION_THRESHOLD);
    expect(r!.confidence).toBeGreaterThan(0);
  });

  test('threshold override for ablation studies', async () => {
    const claim = 'a';
    const responses = ['b', 'c'];
    const client = mockClient({
      a: [1, 0],
      b: [0.6, 0.8],
      c: [0.6, 0.8],
    });
    // Default threshold 0.4 — 0.6 cosine NOT contradictory.
    const rDefault = await compareConsensusToClaim({ claim, responses, embeddingClient: client });
    expect(rDefault!.contradicts).toBe(false);

    // Stricter threshold 0.7 — 0.6 cosine IS contradictory.
    const rStrict = await compareConsensusToClaim({
      claim,
      responses,
      embeddingClient: client,
      contradictionThreshold: 0.7,
    });
    expect(rStrict!.contradicts).toBe(true);
  });

  test('empty responses returns null', async () => {
    const r = await compareConsensusToClaim({ claim: 'x', responses: [] });
    expect(r).toBeNull();
  });

  test('pickConsensus: longest response when no embeddings', () => {
    const responses = ['short', 'a much longer answer here', 'med'];
    const r = _pickConsensusForTest(responses);
    expect(r.answer).toBe('a much longer answer here');
    expect(r.index).toBe(1);
  });

  test('pickConsensus: median-embedding when embeddings provided', () => {
    const responses = ['a', 'b', 'c'];
    // 'b' is the centroid (mean of a, b, c with these vectors).
    const embeddings = [
      [1, 0, 0],
      [0.5, 0.5, 0],
      [0, 1, 0],
    ];
    const r = _pickConsensusForTest(responses, embeddings);
    expect(r.answer).toBe('b');
    expect(r.index).toBe(1);
  });

  test('Jaccard fallback when no embedding client', async () => {
    const claim = 'paris is the capital';
    const responses = ['paris is the capital of france', 'capital paris france'];
    const r = await compareConsensusToClaim({ claim, responses });
    expect(r).not.toBeNull();
    expect(r!.methodology).toBe('fallback-jaccard');
  });
});
