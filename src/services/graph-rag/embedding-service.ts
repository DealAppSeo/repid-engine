// Graph RAG embedding service — Xenova/all-MiniLM-L6-v2 (384 dims).
// Singleton: model load is expensive (~25 MB downloaded from HF CDN on first
// call). After warm-up, mean-pooled normalized embeddings come back in
// ~30-50ms per short string on Railway.
import { pipeline, env } from '@xenova/transformers';

// Force HF CDN (Railway image has no local model cache).
env.allowLocalModels = false;

type FeatureExtractor = Awaited<ReturnType<typeof pipeline>>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

export async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', EMBEDDING_MODEL);
  }
  return extractorPromise;
}

// feature-extraction pipeline returns a Tensor whose `data` is a Float32Array.
// @xenova/transformers types this as a wide union, so we cast the call shape.
type TensorLike = { data: Float32Array | Float64Array };
type FeatureExtractorCallable = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<TensorLike>;

export async function embed(text: string): Promise<number[]> {
  const extractor = (await getExtractor()) as unknown as FeatureExtractorCallable;
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const extractor = (await getExtractor()) as unknown as FeatureExtractorCallable;
  return Promise.all(
    texts.map(async (t) => {
      const output = await extractor(t, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    })
  );
}

export function isExtractorReady(): boolean {
  return extractorPromise !== null;
}
