/**
 * Wave 5 Phase 2 — semantic similarity unit tests.
 *
 * Validates the math of computeSemanticSimilarity / semanticPairSimilarity
 * with a mock embedding client that returns deterministic vectors. The
 * real Xenova/OpenAI/Voyage backends are validated end-to-end in
 * scripts/external-caller-smoke-test.ts (Wave 5 Phase 6).
 *
 * Why mock rather than load Xenova in jest: @xenova/transformers uses
 * dynamic ESM imports which fail in jest's default VM context (would
 * require --experimental-vm-modules). The dependency-free unit test
 * validates the math; the smoke test validates the real backend.
 */
import { computeSemanticSimilarity, semanticPairSimilarity } from '../src/hal/lib/semantic';
import type { HALEmbeddingClient } from '../src/hal/lib/types';

/** Build a mock client that returns the exact vectors specified per text. */
function mockClient(table: Record<string, number[]>): HALEmbeddingClient {
  return {
    async embed(text: string): Promise<number[]> {
      const v = table[text];
      if (!v) throw new Error(`mock: no vector for ${JSON.stringify(text.slice(0, 50))}`);
      return v;
    },
    async embedMany(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map(t => this.embed(t)));
    },
  };
}

describe('semantic similarity (Wave 5 Phase 2)', () => {
  test('three prose-varied correct answers cosine > 0.85', async () => {
    // Realistic sentence-embedding behaviour: prose-varied correct answers
    // about the same fact cluster tightly in semantic space. Mock vectors
    // chosen to produce pairwise cosine ≈ 0.92.
    const responses = [
      'Pythagorean Comma is approximately 23.46 cents from 531441:524288.',
      "It's about 23.46 cents derived from 531441/524288.",
      '≈ 23.46 cents (ratio 531441:524288).',
    ];
    const client = mockClient({
      [responses[0]!]: [0.9, 0.4, 0.1, 0.2],
      [responses[1]!]: [0.85, 0.45, 0.12, 0.18],
      [responses[2]!]: [0.88, 0.42, 0.11, 0.21],
    });
    const r = await computeSemanticSimilarity(responses, client);
    expect(r.methodology).toBe('embedding-cosine');
    expect(r.meanScore).toBeGreaterThan(0.85);
    expect(r.minScore).toBeGreaterThan(0.85);
  });

  test('three unrelated answers cosine < 0.5', async () => {
    const responses = ['Paris', 'binary tree', 'Pythagorean Comma'];
    // Orthogonal-ish vectors — cosine ≈ 0.
    const client = mockClient({
      Paris: [1, 0, 0, 0],
      'binary tree': [0, 1, 0, 0],
      'Pythagorean Comma': [0, 0, 1, 0],
    });
    const r = await computeSemanticSimilarity(responses, client);
    expect(r.methodology).toBe('embedding-cosine');
    expect(r.meanScore).toBeLessThan(0.5);
  });

  test('identical embeddings cosine ≈ 1', async () => {
    const responses = ['a', 'b', 'c'];
    const client = mockClient({
      a: [1, 2, 3, 4],
      b: [1, 2, 3, 4],
      c: [1, 2, 3, 4],
    });
    const r = await computeSemanticSimilarity(responses, client);
    expect(r.methodology).toBe('embedding-cosine');
    expect(r.meanScore).toBeCloseTo(1, 5);
  });

  test('single response returns mean=1', async () => {
    const r = await computeSemanticSimilarity(['only one']);
    expect(r.meanScore).toBe(1);
    expect(r.pairwiseScores.length).toBe(0);
  });

  test('empty input returns mean=0', async () => {
    const r = await computeSemanticSimilarity([]);
    expect(r.meanScore).toBe(0);
    expect(r.pairwiseScores.length).toBe(0);
  });

  test('Jaccard fallback when no client provided', async () => {
    const responses = ['the cat sat on the mat', 'the cat sat on the mat'];
    const r = await computeSemanticSimilarity(responses);
    expect(r.methodology).toBe('fallback-jaccard');
    expect(r.meanScore).toBeCloseTo(1, 3);
  });

  test('Jaccard fallback when client throws', async () => {
    const failingClient: HALEmbeddingClient = {
      async embed(): Promise<number[]> { throw new Error('quota'); },
      async embedMany(): Promise<number[][]> { throw new Error('quota'); },
    };
    const r = await computeSemanticSimilarity(['x', 'y'], failingClient);
    expect(r.methodology).toBe('fallback-jaccard');
  });

  test('semanticPairSimilarity: claim vs identical claim ≈ 1', async () => {
    const text = 'The capital of France is Paris.';
    const client = mockClient({ [text]: [1, 0, 0] });
    const r = await semanticPairSimilarity(text, text, client);
    expect(r.similarity).toBeCloseTo(1, 5);
    expect(r.methodology).toBe('embedding-cosine');
  });

  test('semanticPairSimilarity: claim vs orthogonal answer cosine ≈ 0', async () => {
    const claim = 'Berlin';
    const consensus = 'Paris';
    const client = mockClient({
      Berlin: [1, 0, 0],
      Paris: [0, 1, 0],
    });
    const r = await semanticPairSimilarity(claim, consensus, client);
    expect(r.similarity).toBeCloseTo(0, 5);
  });
});
