/**
 * Fill embeddings for agent_memory_nodes that have none.
 *
 * WHY THIS EXISTS AS A SEPARATE PASS. The score-events backfill
 * (migrations/2026-08-11-graph-rag-backfill-score-events.sql) derives its nodes entirely in
 * SQL, which cannot run all-MiniLM-L6-v2. Those nodes land with embedding IS NULL, and
 * `graph_rag_match_nodes` filters on `n.embedding IS NOT NULL` — so until this runs, a
 * backfilled node exists, is traversable by edge, is queryable by agent, and is COMPLETELY
 * INVISIBLE to the vector search that is the primary retrieval path.
 *
 * That is a half-wired mechanism, which this repo has learned to treat as worse than an
 * absent one: someone reading `agent_memory_nodes` sees 429 rows and concludes memory is
 * populated. Hence this script, hence the loud accounting at the end, and hence the
 * migration's own summary reporting `nodes_without_embedding` rather than declaring itself
 * finished.
 *
 * Usage:
 *   npm run graph-rag:backfill-embeddings                 # dry-run: report only
 *   npm run graph-rag:backfill-embeddings -- --apply      # write embeddings
 *   npm run graph-rag:backfill-embeddings -- --apply --limit 50
 *   npm run graph-rag:backfill-embeddings -- --tag score-events-v1
 *
 * NETWORK. The model is fetched from the HuggingFace CDN on first call (~25 MB, cached by
 * @xenova/transformers afterwards). It will NOT run in an environment whose egress proxy
 * blocks huggingface.co — that is exactly why the backfill migration does not pretend to
 * have done this step.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { config } from '../../src/config';
import { embed, EMBEDDING_MODEL } from '../../src/services/graph-rag/embedding-service';
import {
  parseArgs,
  toPgVector,
  assertEmbeddingShape,
} from '../../src/services/graph-rag/embedding-backfill';

interface NodeRow { id: string; content: string; metadata: Record<string, unknown> | null }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[embeddings] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} model=${EMBEDDING_MODEL} limit=${args.limit}${args.tag ? ` tag=${args.tag}` : ''}`);

  const db = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });

  let q = db
    .from('agent_memory_nodes')
    .select('id, content, metadata')
    .is('embedding', null)
    .order('id', { ascending: true })
    .limit(args.limit);
  if (args.tag) q = q.eq('metadata->>backfill_tag', args.tag);

  const { data, error } = await q;
  if (error) throw new Error(`select failed: ${error.message}`);
  const rows = (data ?? []) as NodeRow[];

  // Total outstanding, independent of --limit, so a capped run cannot read as a finished one.
  const { count: outstanding } = await db
    .from('agent_memory_nodes')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null);

  console.log(`[embeddings] ${rows.length} node(s) selected; ${outstanding ?? '?'} without an embedding in total`);
  if (rows.length === 0) {
    console.log('[embeddings] nothing to do');
    return;
  }

  if (!args.apply) {
    for (const r of rows.slice(0, 5)) {
      console.log(`    ${r.id}  ${r.content.slice(0, 90)}${r.content.length > 90 ? '…' : ''}`);
    }
    if (rows.length > 5) console.log(`    … and ${rows.length - 5} more`);
    console.log('[embeddings] DRY-RUN — no writes. Re-run with --apply');
    return;
  }

  let written = 0;
  let failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i += args.batch) {
    const batch = rows.slice(i, i + args.batch);
    for (const row of batch) {
      try {
        const v = await embed(row.content);
        assertEmbeddingShape(v, row.id);
        const { error: upErr } = await db
          .from('agent_memory_nodes')
          .update({ embedding: toPgVector(v) })
          .eq('id', row.id)
          // Only ever fill a NULL. A concurrent run — or a re-run over a node someone has
          // since embedded properly — must not overwrite an existing vector.
          .is('embedding', null);
        if (upErr) throw new Error(upErr.message);
        written++;
      } catch (e) {
        failed++;
        console.warn(`[embeddings] node ${row.id} failed: ${(e as Error).message}`);
      }
    }
    console.log(`[embeddings] ${Math.min(i + args.batch, rows.length)}/${rows.length} (${written} written, ${failed} failed)`);
  }

  const { count: stillNull } = await db
    .from('agent_memory_nodes')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null);

  console.log('[embeddings] result:');
  console.log(`    written:              ${written}`);
  console.log(`    failed:               ${failed}`);
  console.log(`    still without vector: ${stillNull ?? '?'}`);
  console.log(`    elapsed:              ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if ((stillNull ?? 0) > 0) {
    console.log('[embeddings] NOT COMPLETE — those nodes remain invisible to graph_rag_match_nodes');
  }
  console.log('[embeddings] DONE');
}

// Guard so the pure helpers above can be imported by tests without executing a run.
if (require.main === module) {
  main().catch((e) => {
    console.error('backfill-embeddings crashed:', e);
    process.exit(1);
  });
}
