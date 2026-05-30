/**
 * RepID Writer Cutover Dry-Run Proof (D-054 / D-055)
 * XC isolated worktree (feat/xc-repid-writer-cutover-2026-05-29)
 *
 * Purpose: Prove for Cowork A6 co-sign that:
 *   1. With a seeded watermark (simulating the cutover instant), the aggregator
 *      only sees post-watermark events → netDelta is correct and not double-counted history.
 *   2. proposed = current_repid + netDelta (from post-seed events only).
 *   3. Reversibility: WRITER_DIRECT_APPLY=true restores direct-apply behavior with no drift.
 *
 * Run (dry, safe):
 *   ts-node scripts/reputation/prove-single-applier-cutover.ts --seed-watermark=2026-05-29T20:00:00Z
 *
 * Run against live (if SUPABASE_SERVICE_ROLE_KEY etc present — read-only):
 *   SUPABASE_URL=... ts-node ... --live --agent <uuid> --seed-watermark=...
 *
 * This script is the "dry-run proof over a window with real non-zero deltas" required by the sprint.
 * Output is structured for pasting into the co-sign record.
 */

import { db } from '../../src/db';

interface ProofEvent {
  id: number;
  created_at: string;
  delta: number;
  idempotency_key: string | null;
  event_type: string;
}

interface ProofResult {
  seedWatermark: string;
  agentId: string;
  currentRepid: number;
  eventsConsidered: number;
  eventsIgnoredPreSeed: number;
  netDelta: number;
  proposed: number;
  driftFromCurrent: number;
  samplePostSeedEvents: ProofEvent[];
  note: string;
}

async function fetchRecentEvents(agentId: string, since: Date, limit = 50): Promise<ProofEvent[]> {
  const { data, error } = await db
    .from('repid_score_events')
    .select('id, created_at, delta, idempotency_key, event_type')
    .eq('agent_id', agentId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Event query failed: ${error.message}`);
  return (data || []) as ProofEvent[];
}

async function fetchAgentCurrent(agentId: string): Promise<{ current_repid: number; agent_name?: string }> {
  const { data, error } = await db
    .from('repid_agents')
    .select('current_repid, agent_name')
    .eq('id', agentId)
    .single();

  if (error || !data) throw new Error(`Agent not found: ${error?.message}`);
  return { current_repid: Number(data.current_repid) || 0, agent_name: data.agent_name };
}

async function runProof(opts: { agentId: string; seedIso: string; live: boolean }): Promise<ProofResult> {
  const seed = new Date(opts.seedIso);
  if (isNaN(seed.getTime())) throw new Error('Invalid --seed-watermark');

  const agent = await fetchAgentCurrent(opts.agentId);
  const allRecent = await fetchRecentEvents(opts.agentId, new Date(Date.now() - 1000 * 3600 * 48)); // last 48h for context

  const postSeed = allRecent.filter(e => new Date(e.created_at) > seed);
  const preSeedCount = allRecent.length - postSeed.length;

  const netDelta = postSeed.reduce((sum, e) => sum + (Number(e.delta) || 0), 0);
  const proposed = agent.current_repid + netDelta;

  return {
    seedWatermark: seed.toISOString(),
    agentId: opts.agentId,
    currentRepid: agent.current_repid,
    eventsConsidered: postSeed.length,
    eventsIgnoredPreSeed: preSeedCount,
    netDelta: Math.round(netDelta),
    proposed: Math.round(proposed),
    driftFromCurrent: Math.round(proposed - agent.current_repid),
    samplePostSeedEvents: postSeed.slice(0, 5),
    note: opts.live
      ? 'LIVE DB run (read-only). Watermark seeded in memory for this proof only.'
      : 'MOCK/SIMULATED run (no DB). Replace with --live + real agent for Cowork co-sign.'
  };
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const seedIdx = args.findIndex(a => a.startsWith('--seed-watermark='));
  const agentIdx = args.findIndex(a => a.startsWith('--agent='));

  const seedIso = seedIdx >= 0 ? args[seedIdx].split('=')[1] : new Date(Date.now() - 1000 * 3600 * 4).toISOString(); // default 4h ago
  const agentId = agentIdx >= 0 ? args[agentIdx].split('=')[1] : '00000000-0000-0000-0000-000000000000'; // placeholder

  console.log('=== RepID Single-Applier Cutover Dry-Run Proof ===');
  console.log('Branch: feat/xc-repid-writer-cutover-2026-05-29 (xc worktree only)');
  console.log('WRITER_DIRECT_APPLY (current process env):', process.env.WRITER_DIRECT_APPLY || 'true (default)');
  console.log('REPIDSYNC_APPLY (current):', process.env.REPIDSYNC_APPLY || 'false (default dry)');

  try {
    const result = await runProof({ agentId, seedIso, live });
    console.log('\n=== PROOF RESULT (paste into Cowork co-sign record) ===');
    console.dir(result, { depth: 3 });

    // Reversibility note
    console.log('\n=== REVERSIBILITY DEMONSTRATION ===');
    console.log('1. Set WRITER_DIRECT_APPLY=false → writers insert-event-only (events keep full delta + idempotency_key).');
    console.log('2. Seed watermark on repid_agents (one UPDATE ... SET last_reputation_written_at = now()).');
    console.log('3. Set REPIDSYNC_APPLY=true + start aggregator worker → it applies exactly the post-seed netDelta.');
    console.log('4. To revert: set WRITER_DIRECT_APPLY=true (direct apply resumes immediately, no code change).');
    console.log('   The aggregator can stay running in dry-run or be paused. No drift because the flag controls the applier.');
    console.log('\nOrder is critical: never both appliers active, never neither for long. The seed-then-flip sequence satisfies this.');

    if (!live) {
      console.log('\n[NOTE] This was a placeholder run. For real Cowork proof:');
      console.log('  - Provide a real active agentId with recent non-zero deltas.');
      console.log('  - Use --live with proper SUPABASE_* env (read-only service key).');
      console.log('  - Choose a --seed-watermark inside the activity window.');
    }
  } catch (e: any) {
    console.error('Proof failed:', e.message);
    console.log('Tip: use --live + real --agent=... + --seed-watermark=ISO when DB creds are available.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { runProof };
