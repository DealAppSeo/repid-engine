/**
 * Pure helpers for the embedding backfill pass.
 *
 * These live in src/ rather than beside the CLI because scripts/graph-rag/backfill-embeddings.ts
 * imports `config`, which throws at module load without Supabase credentials — importing the
 * CLI to unit-test its argument parser would make the parser untestable anywhere the service
 * role key is absent, which is everywhere except production and CI.
 */
import { EMBEDDING_DIM } from './embedding-service';

export interface BackfillArgs {
  apply: boolean;
  limit: number;
  batch: number;
  tag?: string;
}

/** Default cap. A run that silently walks an unbounded table is hard to reason about. */
export const DEFAULT_LIMIT = 5000;
export const DEFAULT_BATCH = 25;

export function parseArgs(argv: string[]): BackfillArgs {
  const out: BackfillArgs = { apply: false, limit: DEFAULT_LIMIT, batch: DEFAULT_BATCH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--batch') out.batch = Number(argv[++i]);
    else if (a === '--tag') out.tag = argv[++i];
  }
  // Refused rather than defaulted: coercing NaN back to the default would make
  // `--limit all` quietly process 5000 rows while the operator believes they capped it.
  if (!Number.isFinite(out.limit) || out.limit < 1) {
    throw new Error(`--limit must be a positive number (got ${out.limit})`);
  }
  if (!Number.isFinite(out.batch) || out.batch < 1) {
    throw new Error(`--batch must be a positive number (got ${out.batch})`);
  }
  return out;
}

/**
 * pgvector over PostgREST wants the bracketed literal. Same two-line format as
 * GraphRagStore's private helper; the equivalence is pinned by a test rather than by
 * importing the store, which would drag its whole insert path into this pass.
 */
export function toPgVector(arr: number[]): string {
  return '[' + arr.join(',') + ']';
}

/**
 * A wrong-length vector is rejected by the column type too, but the failure surfaces as an
 * opaque PostgREST error several layers from the cause — which is almost always "a different
 * model got loaded". Check it where the cause is.
 */
export function assertEmbeddingShape(v: number[], nodeId: string): void {
  if (v.length !== EMBEDDING_DIM) {
    throw new Error(
      `node ${nodeId}: embedding has ${v.length} dims, expected ${EMBEDDING_DIM} (wrong model loaded?)`,
    );
  }
  if (!v.every((x) => Number.isFinite(x))) {
    throw new Error(`node ${nodeId}: embedding contains a non-finite value`);
  }
}
