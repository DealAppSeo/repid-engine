/**
 * Graph RAG end-to-end verification harness.
 *
 * Exercises the full Graph RAG loop in production:
 *   migration → store.createNode → hal-memory-hook → retrieval → pre-LLM injection
 *
 * USAGE:
 *   npm run verify:graph-rag                    # full run against production
 *   npm run verify:graph-rag -- --dry-run       # check migration only
 *   npm run verify:graph-rag -- --keep          # don't clean up test data
 *   npm run verify:graph-rag -- --agent <uuid>  # use a specific test agent
 *
 * EXIT CODES:
 *   0 = all assertions passed, OR migration not yet applied (clean state)
 *   1 = at least one assertion failed
 *   2 = harness itself crashed
 *
 * Cleanup contract: harness writes ONLY to the designated test agent and
 * tags every node it creates with `metadata.harness=true`. The cleanup
 * step deletes those rows (and only those rows) at the end. Cascade-delete
 * via FK takes the matching edges with them.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { GraphRagStore } from '../src/services/graph-rag/graph-rag-store';
import { RetrievalService } from '../src/services/graph-rag/retrieval-service';
import { writeDecisionMemory } from '../src/services/graph-rag/hal-memory-hook';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars'
  );
  process.exit(2);
}

interface Assertion {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  elapsed_ms?: number;
  skipped?: boolean;
}

const results: Assertion[] = [];

function record(a: Assertion): void {
  results.push(a);
  const icon = a.skipped ? '⏭️' : a.pass ? '✅' : '❌';
  const time = a.elapsed_ms != null ? ` (${a.elapsed_ms}ms)` : '';
  console.log(`${icon} ${a.name}${time}`);
  if (!a.pass && !a.skipped) {
    console.log(`   expected: ${a.expected}`);
    console.log(`   actual:   ${a.actual}`);
  } else if (a.skipped) {
    console.log(`   reason:   ${a.actual}`);
  }
}

function parseArgs(): {
  dryRun: boolean;
  keep: boolean;
  agentArg: string | null;
} {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const keep = argv.includes('--keep');
  const idx = argv.indexOf('--agent');
  const agentArg = idx >= 0 ? argv[idx + 1] ?? null : null;
  return { dryRun, keep, agentArg };
}

interface MigrationStatus {
  nodes: boolean;
  edges: boolean;
  rpc: boolean;
}

async function checkMigrationApplied(
  supabase: SupabaseClient
): Promise<MigrationStatus> {
  // Probe each piece via the lightest available query. supabase-js returns
  // an error with code 'PGRST204' (or message containing "does not exist")
  // when the relation/function is missing.

  let nodes = false;
  try {
    const r = await supabase.from('agent_memory_nodes').select('id').limit(0);
    nodes = !r.error;
  } catch {
    nodes = false;
  }

  let edges = false;
  try {
    const r = await supabase.from('agent_memory_edges').select('id').limit(0);
    edges = !r.error;
  } catch {
    edges = false;
  }

  // RPC probe: call graph_rag_match_nodes with valid-shape args. If the
  // function exists it will return [] (no agent has nodes); if it doesn't
  // exist, error.message will contain "does not exist" or "function ... does not exist".
  let rpc = false;
  try {
    const zeroEmbedding = '[' + Array(384).fill(0).join(',') + ']';
    const r = await supabase.rpc('graph_rag_match_nodes', {
      p_agent_id: '00000000-0000-0000-0000-000000000000',
      p_query_embedding: zeroEmbedding,
      p_match_count: 1,
      p_similarity_threshold: 0.99,
      p_node_types: null,
    } as any);
    if (!r.error) {
      rpc = true;
    } else {
      // If error mentions "does not exist" / "function" / "PGRST202", RPC is missing.
      // Anything else (e.g. permission) means it exists.
      const msg = (r.error.message || '').toLowerCase();
      rpc = !(msg.includes('does not exist') || msg.includes('not find'));
    }
  } catch {
    rpc = false;
  }

  return { nodes, edges, rpc };
}

const HARNESS_AGENT_NAME = 'GRAPH_RAG_HARNESS_TEST';
const FALLBACK_AGENT_NAMES = ['HalTester6', 'A7SmokeTest', 'smoke'];

async function ensureTestAgent(
  supabase: SupabaseClient,
  override: string | null
): Promise<{ id: string; source: string }> {
  if (override) return { id: override, source: 'cli flag' };

  // Try to find existing harness agent
  const existing = await supabase
    .from('repid_agents')
    .select('id')
    .eq('agent_name', HARNESS_AGENT_NAME)
    .limit(1)
    .maybeSingle();
  if (existing.data?.id) {
    return { id: existing.data.id as string, source: 'existing harness agent' };
  }

  // Try to create one (best-effort — many columns are nullable, trigger fills tier)
  const created = await supabase
    .from('repid_agents')
    .insert({
      agent_name: HARNESS_AGENT_NAME,
      current_repid: 100,
      tier: 'PROBATIONARY',
      is_human: false,
      agent_type: 'external',
      constitution: { version: 'harness-v1', type: 'TEST' },
    })
    .select('id')
    .single();
  if (!created.error && created.data?.id) {
    return { id: created.data.id as string, source: 'fresh create' };
  }

  // Fallback: reuse an existing smoke-test agent
  for (const name of FALLBACK_AGENT_NAMES) {
    const fb = await supabase
      .from('repid_agents')
      .select('id')
      .eq('agent_name', name)
      .limit(1)
      .maybeSingle();
    if (fb.data?.id) {
      return {
        id: fb.data.id as string,
        source: `fallback to existing '${name}'`,
      };
    }
  }

  throw new Error(
    `Cannot acquire test agent. Create failed: ${created.error?.message ?? 'unknown'}. ` +
      `Provide --agent <uuid> to use a specific agent.`
  );
}

async function cleanupHarnessNodes(
  supabase: SupabaseClient,
  agentId: string
): Promise<{ deleted: number; error: string | null }> {
  // Find harness-tagged nodes for this agent, then delete by id (so we can
  // count what we removed). FK cascade on agent_memory_edges takes the
  // edges automatically.
  const { data: rows, error: selErr } = await supabase
    .from('agent_memory_nodes')
    .select('id')
    .eq('agent_id', agentId)
    .contains('metadata', { harness: true });
  if (selErr) return { deleted: 0, error: selErr.message };
  const ids = (rows ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return { deleted: 0, error: null };
  const { error: delErr } = await supabase
    .from('agent_memory_nodes')
    .delete()
    .in('id', ids);
  if (delErr) return { deleted: 0, error: delErr.message };
  return { deleted: ids.length, error: null };
}

/**
 * Gemini's pre-LLM injection module (Wave 6) ships in a parallel branch.
 * We attempt to load it dynamically; if the module isn't on disk yet, A8/A9
 * are recorded as SKIPPED rather than failed.
 */
async function tryLoadPreLLMInjection(): Promise<
  | {
      buildMemoryContext: (
        supabase: SupabaseClient,
        opts: {
          agent_id: string;
          prompt: string;
          top_k?: number;
          similarity_threshold?: number;
        },
        timeoutMs?: number
      ) => Promise<{ formatted: string; memories: unknown[] }>;
    }
  | null
> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../src/services/graph-rag/pre-llm-injection');
    if (mod && typeof mod.buildMemoryContext === 'function') {
      return { buildMemoryContext: mod.buildMemoryContext };
    }
    return null;
  } catch {
    return null;
  }
}

function printSummary(): void {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log('\n=================================');
  console.log(
    `Summary: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`
  );
  if (failed > 0) {
    console.log('\nFailed assertions:');
    for (const r of results.filter((rr) => !rr.pass && !rr.skipped)) {
      console.log(`  - ${r.name}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('🧪 Graph RAG Verification Harness');
  console.log('=================================');
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  console.log(`Mode:         ${args.dryRun ? 'DRY RUN (migration check only)' : 'FULL'}`);
  console.log(`Cleanup:      ${args.keep ? 'OFF (--keep)' : 'ON'}`);
  console.log('');

  // --- Migration probe ---
  const mig = await checkMigrationApplied(supabase);
  record({
    name: 'A1: agent_memory_nodes table exists',
    pass: mig.nodes,
    expected: 'true',
    actual: String(mig.nodes),
  });
  record({
    name: 'A2: agent_memory_edges table exists',
    pass: mig.edges,
    expected: 'true',
    actual: String(mig.edges),
  });
  record({
    name: 'A3: graph_rag_match_nodes RPC exists',
    pass: mig.rpc,
    expected: 'true',
    actual: String(mig.rpc),
  });

  if (!mig.nodes || !mig.edges || !mig.rpc) {
    console.log('\n⏸  Migration not yet applied.');
    console.log(
      '   Run me again after Sean applies 2026-05-10-graph-rag-foundation.sql in Supabase Studio.'
    );
    printSummary();
    process.exit(0); // clean exit, not failure
  }

  if (args.dryRun) {
    console.log('\n--dry-run: migration check complete, stopping here.');
    printSummary();
    process.exit(0);
  }

  // --- Test agent ---
  let agentId: string;
  let agentSource: string;
  try {
    const { id, source } = await ensureTestAgent(supabase, args.agentArg);
    agentId = id;
    agentSource = source;
    record({
      name: 'A4: harness test agent provisioned',
      pass: true,
      expected: 'agent UUID',
      actual: `${agentId} (${source})`,
    });
    console.log(`   using: ${agentId} [${agentSource}]\n`);
  } catch (e: unknown) {
    record({
      name: 'A4: harness test agent provisioned',
      pass: false,
      expected: 'agent UUID',
      actual: e instanceof Error ? e.message : String(e),
    });
    printSummary();
    process.exit(1);
  }

  try {
    // --- A5: GraphRagStore.createNode ---
    const store = new GraphRagStore(supabase);
    const t0 = Date.now();
    let createdNodeId: string | null = null;
    try {
      const obsNode = await store.createNode({
        agent_id: agentId,
        node_type: 'observation',
        content:
          'The harness saw a unicorn chasing a rainbow at 3pm. Cinnamon. Citrus. Bridge.',
        importance: 0.5,
        metadata: { harness: true, run_id: Date.now() },
      });
      createdNodeId = obsNode?.id ?? null;
      record({
        name: 'A5: GraphRagStore.createNode writes observation',
        pass: !!obsNode?.id,
        expected: 'node with UUID',
        actual: obsNode?.id ?? 'null',
        elapsed_ms: Date.now() - t0,
      });
    } catch (e: unknown) {
      record({
        name: 'A5: GraphRagStore.createNode writes observation',
        pass: false,
        expected: 'node with UUID',
        actual: e instanceof Error ? e.message : String(e),
        elapsed_ms: Date.now() - t0,
      });
    }

    // --- A6: hal-memory-hook.writeDecisionMemory (fire-and-forget, never throws) ---
    const t1 = Date.now();
    let hookThrew = false;
    try {
      await writeDecisionMemory(supabase, {
        agentId,
        prompt:
          'The harness saw a unicorn chasing a rainbow at 3pm. Cinnamon. Citrus. Bridge.',
        decisionText:
          'Acknowledged unicorn-rainbow event with low confidence. (harness)',
        halScore: 0.12,
        repidDelta: 0,
        newRepid: 100,
        commaVeto: false,
      });
    } catch (e: unknown) {
      hookThrew = true;
      console.error(
        '   writeDecisionMemory unexpectedly threw:',
        e instanceof Error ? e.message : e
      );
    }
    record({
      name: 'A6: hal-memory-hook.writeDecisionMemory completes',
      pass: !hookThrew,
      expected: 'no exception (fire-and-forget contract)',
      actual: hookThrew ? 'threw' : 'completed',
      elapsed_ms: Date.now() - t1,
    });

    // --- A6.5: tag the hook's nodes with harness=true so cleanup catches them ---
    // hal-memory-hook tags with source:'hal_pipeline'; not harness=true. Patch
    // them post-hoc to ensure cleanup catches them.
    try {
      await supabase
        .from('agent_memory_nodes')
        .update({ metadata: { source: 'hal_pipeline', harness: true } })
        .eq('agent_id', agentId)
        .eq('content', 'The harness saw a unicorn chasing a rainbow at 3pm. Cinnamon. Citrus. Bridge.');
    } catch {
      /* best-effort */
    }

    // --- A7: RetrievalService.retrieve returns the planted observation ---
    const t2 = Date.now();
    try {
      const retrieval = new RetrievalService(supabase);
      const matches = await retrieval.retrieve({
        agent_id: agentId,
        query: 'rainbow unicorn afternoon',
        top_k: 3,
        similarity_threshold: 0.3,
        include_related: false,
      });
      const pass = matches.length >= 1;
      record({
        name: 'A7: RetrievalService.retrieve returns >=1 match',
        pass,
        expected: '>=1 match for "rainbow unicorn afternoon"',
        actual: pass
          ? `${matches.length} matches (top similarity=${matches[0]?.similarity.toFixed(3) ?? 'n/a'})`
          : '0 matches',
        elapsed_ms: Date.now() - t2,
      });
    } catch (e: unknown) {
      record({
        name: 'A7: RetrievalService.retrieve returns >=1 match',
        pass: false,
        expected: '>=1 match',
        actual: e instanceof Error ? e.message : String(e),
        elapsed_ms: Date.now() - t2,
      });
    }

    // --- A8 + A9: pre-LLM injection (Gemini Wave 6) — dynamic load, skip if absent ---
    const preLLM = await tryLoadPreLLMInjection();
    if (!preLLM) {
      record({
        name: 'A8: pre-llm-injection.buildMemoryContext returns formatted context',
        pass: true, // skipped, not failed
        expected: 'non-empty formatted string',
        actual:
          "src/services/graph-rag/pre-llm-injection.ts not present on this branch (Gemini Wave 6 — separate branch)",
        skipped: true,
      });
      record({
        name: 'A9: buildMemoryContext respects timeout (1ms)',
        pass: true,
        expected: 'returns empty in <100ms',
        actual: 'skipped — module not loaded',
        skipped: true,
      });
    } else {
      // A8: normal call with generous timeout
      const t3 = Date.now();
      try {
        const ctx = await preLLM.buildMemoryContext(
          supabase,
          {
            agent_id: agentId,
            prompt: 'tell me about that unicorn',
            top_k: 3,
            similarity_threshold: 0.3,
          },
          2000
        );
        record({
          name: 'A8: pre-llm-injection.buildMemoryContext returns formatted context',
          pass: ctx.formatted.length > 0,
          expected: 'non-empty formatted string',
          actual:
            ctx.formatted.length > 0
              ? `${ctx.formatted.length} chars, ${ctx.memories.length} memories`
              : 'empty (no memories retrieved)',
          elapsed_ms: Date.now() - t3,
        });
      } catch (e: unknown) {
        record({
          name: 'A8: pre-llm-injection.buildMemoryContext returns formatted context',
          pass: false,
          expected: 'non-empty formatted string',
          actual: e instanceof Error ? e.message : String(e),
          elapsed_ms: Date.now() - t3,
        });
      }

      // A9: tight timeout — should fall through to empty without blocking
      const t4 = Date.now();
      try {
        const ctxFast = await preLLM.buildMemoryContext(
          supabase,
          {
            agent_id: agentId,
            prompt: 'tell me about that unicorn',
            top_k: 3,
            similarity_threshold: 0.3,
          },
          1
        );
        const fastElapsed = Date.now() - t4;
        record({
          name: 'A9: buildMemoryContext respects timeout (1ms)',
          pass: fastElapsed < 250 && ctxFast.memories.length === 0,
          expected: 'returns empty in <250ms',
          actual: `${fastElapsed}ms, ${ctxFast.memories.length} memories`,
          elapsed_ms: fastElapsed,
        });
      } catch (e: unknown) {
        record({
          name: 'A9: buildMemoryContext respects timeout (1ms)',
          pass: false,
          expected: 'returns empty in <250ms',
          actual: e instanceof Error ? e.message : String(e),
          elapsed_ms: Date.now() - t4,
        });
      }
    }
  } finally {
    if (args.keep) {
      console.log(
        `\n📌 --keep flag set; test data preserved on agent ${agentId}`
      );
    } else {
      const cleanup = await cleanupHarnessNodes(supabase, agentId);
      if (cleanup.error) {
        console.warn(
          `\n⚠️  Cleanup failed (non-fatal): ${cleanup.error}`
        );
      } else {
        console.log(
          `\n🧹 Cleaned up ${cleanup.deleted} harness node(s) on agent ${agentId}`
        );
      }
    }
  }

  printSummary();
  const anyHardFail = results.some((r) => !r.pass && !r.skipped);
  process.exit(anyHardFail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n💥 Harness crashed:', err);
  process.exit(2);
});
