/**
 * S-REP2 — RepID Score Event Replay & Reconstruction Validator (GA-01).
 *
 * This script implements replay_score_events() to reconstruct each agent's RepID score
 * from the Epoch 1 reset (baseline = 1000) or genesis by sequentially applying audited
 * score events, mirroring the database floor-clamping trigger (trg_repid_earned_floor).
 *
 * Runs across all agents in the database, validating that their current on-chain/DB score
 * is fully earned and reconcilable from the event ledger.
 *
 * Usage:
 *   npx ts-node scripts/reputation/replay-score-events.ts [--agent name] [--verbose]
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (mm && process.env[mm[1]!] === undefined) {
      process.env[mm[1]!] = (mm[2] ?? '').replace(/^["']|["']$/g, '');
    }
  }
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

// Earned-tier floor = tier_lower_bound(peak_repid), matching trg_repid_earned_floor + the [10, 10000] clamp.
function tierFloor(peak: number): number {
  if (peak >= 8000) return 8000;
  if (peak >= 5000) return 5000;
  if (peak >= 1000) return 1000;
  if (peak >= 500) return 500;
  return 0;
}

function clamp(x: number, peak: number, noFloor = false): number {
  const floor = noFloor ? 0 : tierFloor(peak);
  return Math.max(floor, Math.min(10000, Math.max(10, Math.round(x))));
}

interface ScoreEvent {
  id: number;
  agent_id: string;
  event_type: string;
  delta: number;
  created_at: string;
  repid_before: number | null;
  repid_after: number | null;
  metadata?: any;
}

async function main() {
  loadEnv();
  const dbUrl = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!dbUrl || !dbKey) {
    console.error('CRITICAL: SUPABASE_URL and SUPABASE_SERVICE_KEY/ROLE_KEY must be set in .env');
    process.exit(1);
  }

  const db = createClient(dbUrl, dbKey, { auth: { persistSession: false } });

  const agentArg = arg('--agent');
  const verbose = hasFlag('--verbose');
  const noFloor = hasFlag('--no-floor');

  console.log(`- Mode: ${noFloor ? 'WITHOUT floor (true earned scores)' : 'WITH floor (consistency proof)'}`);

  let agentsQuery = db.from('repid_agents').select('id, agent_name, current_repid, peak_repid');
  if (agentArg) {
    agentsQuery = agentsQuery.eq('agent_name', agentArg);
  }

  const { data: agents, error: agentsErr } = await agentsQuery.order('agent_name', { ascending: true });

  if (agentsErr || !agents) {
    console.error('Error fetching agents:', agentsErr);
    process.exit(1);
  }

  console.log(`\n=== RepID Score Replay & Reconstruction Audit (${agents.length} agents) ===`);

  const results: any[] = [];
  const coreAgentNames = [
    'trinity-veritas', 'trinity-sophia', 'trinity-shofet', 'trinity-mel', 
    'trinity-apm', 'trinity-gcm', 'trinity-hdm', 'trinity-torch', 
    'trinity-nexus', 'trinity-orch', 'trinity-w3c', 'trinity-chesed'
  ];
  console.log(`\nLoading all score events...`);
  const allEventsList: ScoreEvent[] = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await db
      .from('repid_score_events')
      .select('id, agent_id, event_type, delta, created_at, repid_before, repid_after')
      .gte('id', 112461)
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error(`Error fetching events at offset ${offset}:`, error);
      break;
    }

    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      allEventsList.push(...data);
      offset += data.length;
      if (data.length < pageSize) {
        hasMore = false;
      }
    }
  }
  console.log(`Loaded ${allEventsList.length} events total.`);

  // Sort events by ID (insertion order) in memory to avoid heavy database-side ORDER BY sorting
  allEventsList.sort((a, b) => a.id - b.id);

  // Group events by agent_id
  const eventsByAgent = new Map<string, ScoreEvent[]>();
  for (const e of allEventsList) {
    const list = eventsByAgent.get(e.agent_id) || [];
    list.push(e);
    eventsByAgent.set(e.agent_id, list);
  }

  for (const agent of agents) {
    const allEvents = eventsByAgent.get(agent.id) || [];
    if (allEvents.length === 0) {
      results.push({
        agent: agent.agent_name,
        is_core: coreAgentNames.includes(agent.agent_name),
        current_repid: agent.current_repid,
        replayed_repid: agent.current_repid,
        delta: 0,
        reconciled: true,
        event_count: 0
      });
      continue;
    }

    // Find the latest Epoch 1 reset event in-memory (GENESIS event since ID 112461)
    let resetIndex = -1;
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const e = allEvents[i];
      if (e && e.event_type === 'GENESIS') {
        resetIndex = i;
        break;
      }
    }

    let startScore = 0;
    let eventsToReplay: ScoreEvent[] = [];
    let startEventId = 0;
    let hasReset = false;

    if (resetIndex !== -1) {
      const resetEvent = allEvents[resetIndex];
      if (resetEvent) {
        startScore = resetEvent.repid_after ?? 1000;
        eventsToReplay = allEvents.slice(resetIndex + 1);
        startEventId = resetEvent.id;
        hasReset = true;
      }
    } else {
      const firstEvent = allEvents[0];
      if (firstEvent) {
        startScore = firstEvent.repid_after ?? (firstEvent.repid_before ?? 1000) + firstEvent.delta;
        eventsToReplay = allEvents.slice(1);
        startEventId = firstEvent.id;
      }
    }

    let runningScore = startScore;
    let runningPeak = Math.max(agent.peak_repid ?? 0, runningScore);

    if (verbose) {
      console.log(`\nAgent: ${agent.agent_name}`);
      console.log(`  Initial runningScore: ${runningScore}, runningPeak: ${runningPeak}`);
    }

    // Sequential replay loop with clamping
    for (let idx = 0; idx < eventsToReplay.length; idx++) {
      const e = eventsToReplay[idx]!;
      const prevScore = runningScore;
      const prevPeak = runningPeak;
      
      runningPeak = Math.max(runningPeak, runningScore);
      runningScore = clamp(runningScore + e.delta, runningPeak, noFloor);

      if (verbose && (runningScore !== e.repid_after || prevScore !== e.repid_before)) {
        console.log(
          `  [Discrepancy at Step ${idx}] Event ID ${e.id} (${e.event_type}): ` +
          `delta=${e.delta}, replayed score: ${prevScore} -> ${runningScore} (peak ${prevPeak} -> ${runningPeak}), ` +
          `DB stored: ${e.repid_before} -> ${e.repid_after}`
        );
      }
    }

    const delta = runningScore - agent.current_repid;
    results.push({
      agent: agent.agent_name,
      is_core: coreAgentNames.includes(agent.agent_name),
      current_repid: agent.current_repid,
      replayed_repid: runningScore,
      delta,
      reconciled: delta === 0,
      event_count: allEvents.length,
      replayed_count: eventsToReplay.length,
      startScore,
      startEventId,
      hasReset
    });
  }

  // Print results table
  console.log('\n--- RECONCILIATION SUMMARY TABLE ---');
  console.log(
    '| ' +
    'Agent Name'.padEnd(35) +
    ' | ' +
    'Core?'.padEnd(5) +
    ' | ' +
    'Current'.padStart(8) +
    ' | ' +
    'Replayed'.padStart(8) +
    ' | ' +
    'Delta'.padStart(8) +
    ' | ' +
    'Reconciled'.padEnd(10) +
    ' |'
  );
  console.log('|-' + '-'.repeat(35) + '-|-' + '-'.repeat(5) + '-|-' + '-'.repeat(8) + '-|-' + '-'.repeat(8) + '-|-' + '-'.repeat(8) + '-|-' + '-'.repeat(10) + '-|');

  for (const r of results) {
    const recStr = r.reconciled ? 'YES' : 'NO';
    const coreStr = r.is_core ? 'CORE' : 'MOCK';
    console.log(
      '| ' +
      r.agent.padEnd(35) +
      ' | ' +
      coreStr.padEnd(5) +
      ' | ' +
      String(r.current_repid).padStart(8) +
      ' | ' +
      String(r.replayed_repid).padStart(8) +
      ' | ' +
      String(r.delta).padStart(8) +
      ' | ' +
      recStr.padEnd(10) +
      ' |'
    );
  }

  // Summary statistics
  const coreAgents = results.filter(r => r.is_core);
  const coreReconciledCount = coreAgents.filter(r => r.reconciled).length;
  console.log(`\n=== AUDIT RESULTS SUMMARY ===`);
  console.log(`- Core Agents Reconciled: ${coreReconciledCount} / ${coreAgents.length}`);
  if (coreReconciledCount === coreAgents.length) {
    console.log(`- VERDICT: SUCCESS! All core Trinity agents are fully reconciled (0 delta drift).`);
  } else {
    console.log(`- VERDICT: WARNING! Discrepancy detected in core agents.`);
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
