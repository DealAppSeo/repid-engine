/**
 * Optional embedding-client adapters. The core HAL library defines the
 * `HALEmbeddingClient` interface (method-based); these factories build
 * concrete clients backed by either a local model (`@xenova/transformers`)
 * or the OpenAI embeddings API.
 *
 * Importing this module pulls in the chosen backend's deps. The core
 * library (`src/hal/lib/index.ts`) does NOT import these — callers opt
 * in explicitly.
 */
import type { HALEmbeddingClient } from '../types';

/* ---------------- xenova (local, no network, no key) ---------------- */

/**
 * Build an embedding client backed by `@xenova/transformers` running
 * locally. First call triggers model download (~22MB cached); subsequent
 * calls are CPU-only. Recommended for offline/no-key environments and
 * for HAL tests that must be deterministic.
 *
 * Default model: `Xenova/all-MiniLM-L6-v2` (384-dim, ~22MB).
 */
export interface XenovaEmbeddingOptions {
  /** Hugging Face model id, must be Xenova-compatible (ONNX). */
  model?: string;
  /** Mean-pool + L2-normalize the output (default true — what sentence-transformers does). */
  normalize?: boolean;
}

export async function buildXenovaEmbeddingClient(
  options: XenovaEmbeddingOptions = {},
): Promise<HALEmbeddingClient> {
  const modelId = options.model ?? 'Xenova/all-MiniLM-L6-v2';
  const normalize = options.normalize !== false;

  // Dynamic import so the dependency stays optional: only callers that
  // build a Xenova client pay the load cost.
  const transformers = await import('@xenova/transformers');
  const extractor = await transformers.pipeline('feature-extraction', modelId);

  async function embedOne(text: string): Promise<number[]> {
    const out: any = await extractor(text, { pooling: 'mean', normalize });
    // Tensors expose `.data` (Float32Array). Convert to plain number[].
    const data: ArrayLike<number> = out?.data ?? out;
    const arr: number[] = [];
    for (let i = 0; i < data.length; i++) arr.push(data[i] as number);
    return arr;
  }

  return {
    embed: embedOne,
    async embedMany(texts: string[]): Promise<number[][]> {
      // Batched call avoids re-init per text but the pipeline already
      // serializes; sequential is fine and keeps memory predictable.
      const out: number[][] = [];
      for (const t of texts) out.push(await embedOne(t));
      return out;
    },
  };
}

/* ---------------- OpenAI (network, key required) ---------------- */

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  /** OpenAI model id; default `text-embedding-3-small`. */
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
}

export function buildOpenAIEmbeddingClient(
  options: OpenAIEmbeddingOptions,
): HALEmbeddingClient {
  if (!options.apiKey) {
    throw new Error('buildOpenAIEmbeddingClient: apiKey is required');
  }
  const model = options.model ?? 'text-embedding-3-small';
  const endpoint = options.endpoint ?? 'https://api.openai.com/v1/embeddings';
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function callEmbed(input: string | string[]): Promise<number[][]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model, input }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`openai-embedding ${res.status}: ${body.slice(0, 200)}`);
      }
      const data: any = await res.json();
      const items: any[] = Array.isArray(data?.data) ? data.data : [];
      return items.map(item => {
        const vec = item?.embedding;
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error('openai-embedding: empty vector');
        }
        return vec as number[];
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async embed(text: string): Promise<number[]> {
      const result = await callEmbed(text);
      const v = result[0];
      if (!v) throw new Error('openai-embedding: empty result');
      return v;
    },
    async embedMany(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return callEmbed(texts);
    },
  };
}
