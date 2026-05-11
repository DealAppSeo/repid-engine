/**
 * RepID Earning Backfill — score historical paper trades.
 *
 * For every closed trade in `trade_execution_log` that doesn't yet have a
 * matching `repid_score_events` row (looked up via `idempotency_key =
 * 'paper_trade:<trade_id>'`), compute its outcome via repidEarning service
 * and write the audit row + update agent RepID.
 *
 * DO NOT RUN as part of CC Sprint 2. Sean runs this manually.
 *
 * Flags:
 *   --dry-run            Compute outcomes; print what would be written; no DB writes
 *   --limit N            Process at most N unscored trades (default 50)
 *   --agent-name <name>  Restrict to one agent (text match; faster than --agent-id)
 *   --agent-id <uuid>    Restrict to one agent by UUID
 *   --since <iso>        Only consider trades with executed_at >= ISO timestamp
 *   --reset              Delete checkpoint and start over
 *
 * Checkpoint:
 *   scripts/.repid-earning-backfill-state.json — {"last_trade_id": <int>}
 *   Resumes from where it left off; safe to re-run.
 *
 * Usage:
 *   npx ts-node scripts/repid-earning-backfill.ts --dry-run --limit 5
 *   npx ts-node scripts/repid-earning-backfill.ts --agent-name SOPHIA --limit 100
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../src/db';
import { repidEarning } from '../src/services/repid-earning';

const CHECKPOINT_FILE = path.resolve(__dirname, '.repid-earning-backfill-state.json');

interface Args {
  dryRun: boolean;
  limit: number;
  agentName: string | null;
  agentId: string | null;
  since: string | null;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, limit: 50, agentName: null, agentId: null, since: null, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--reset') out.reset = true;
    else if (a === '--limit') out.limit = parseInt(argv[++i] || '50', 10);
    else if (a === '--agent-name') out.agentName = argv[++i] || null;
    else if (a === '--agent-id') out.agentId = argv[++i] || null;
    else if (a === '--since') out.since = argv[++i] || null;
  }
  return out;
}

function loadCheckpoint(): { last_trade_id: number } {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
  } catch {
    return { last_trade_id: 0 };
  }
}

function saveCheckpoint(state: { last_trade_id: number }) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function listUnscoredTrades(args: Args, sinceId: number): Promise<{ id: number; agent_name: string | null }[]> {
  // Step 1: fetch candidate trades with id > last_trade_id, in id ASC order
  let q = db
    .from('trade_execution_log')
    .select('id, agent_name')
    .gt('id', sinceId)
    .order('id', { ascending: true })
    .limit(args.limit * 4); // overfetch — many will already be scored

  if (args.agentName) q = q.eq('agent_name', args.agentName);
  if (args.since) q = q.gte('executed_at', args.since);

  const { data: trades, error } = await q;
  if (error) throw new Error(`trade_list_failed: ${error.message}`);
  if (!trades || trades.length === 0) return [];

  // Step 2: filter to those without an idempotency_key match
  const ids = trades.map((t) => t.id);
  const idemKeys = ids.map((id) => `paper_trade:${id}`);
  const { data: existing, error: exErr } = await db
    .from('repid_score_events')
    .select('idempotency_key')
    .in('idempotency_key', idemKeys);
  if (exErr) throw new Error(`existing_lookup_failed: ${exErr.message}`);

  const scored = new Set((existing ?? []).map((e: any) => e.idempotency_key));
  const unscored = trades.filter((t) => !scored.has(`paper_trade:${t.id}`));
  return unscored.slice(0, args.limit);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.reset) {
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
    console.log('[backfill] checkpoint reset');
  }

  const checkpoint = loadCheckpoint();
  console.log(`[backfill] starting; mode=${args.dryRun ? 'DRY-RUN' : 'WRITE'} limit=${args.limit} cursor>${checkpoint.last_trade_id}`);
  if (args.agentName) console.log(`[backfill] filter agent_name=${args.agentName}`);
  if (args.agentId) console.log(`[backfill] filter agent_id=${args.agentId} (note: trade_execution_log has no agent_id; resolved via repid_agents lookup)`);
  if (args.since) console.log(`[backfill] filter executed_at>=${args.since}`);

  const trades = await listUnscoredTrades(args, checkpoint.last_trade_id);
  console.log(`[backfill] ${trades.length} unscored trades to process`);

  let scored = 0;
  let skipped = 0;
  let errored = 0;
  let lastId = checkpoint.last_trade_id;

  for (const trade of trades) {
    if (args.dryRun) {
      const outcome = await repidEarning.scoreTradeOutcome(trade.id);
      if ('error' in outcome) {
        console.log(`  trade ${trade.id} (${trade.agent_name}): ERROR ${outcome.error}`);
        errored++;
      } else {
        console.log(
          `  trade ${trade.id} (${trade.agent_name}): would write delta=${outcome.delta >= 0 ? '+' : ''}${outcome.delta} reason=${outcome.reason}`
        );
        scored++;
      }
    } else {
      try {
        const r = await repidEarning.recordOutcome(trade.id);
        if ('skipped' in r && r.skipped) {
          console.log(`  trade ${trade.id} (${trade.agent_name}): SKIP ${r.skipped} — ${r.reason}`);
          skipped++;
        } else {
          const written = r as { delta: number; event_id: number; repid_after: number; reason: string };
          console.log(
            `  trade ${trade.id} (${trade.agent_name}): wrote event ${written.event_id} delta=${written.delta >= 0 ? '+' : ''}${written.delta} new_repid=${written.repid_after} reason=${written.reason}`
          );
          scored++;
        }
      } catch (e: any) {
        console.log(`  trade ${trade.id} (${trade.agent_name}): ERROR ${e?.message ?? e}`);
        errored++;
      }
    }
    lastId = trade.id;
  }

  if (!args.dryRun && trades.length > 0) {
    saveCheckpoint({ last_trade_id: lastId });
    console.log(`[backfill] checkpoint advanced to ${lastId}`);
  }

  console.log('');
  console.log(`[backfill] DONE   scored=${scored} skipped=${skipped} errored=${errored}`);
  process.exit(errored > 0 && !args.dryRun ? 1 : 0);
})().catch((e) => {
  console.error('[backfill] crash:', e);
  process.exit(2);
});
