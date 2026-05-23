import { db } from '../db';
import { pgQuery } from '../db/direct-pg';
import { isEligibleForOnChainWrite, POLL_EVENT_FILTER_SQL } from './feedback-loop-filters';
import { getReputationWriter, persistReputationWrite, type WriteRepIDResult } from '../services/erc8004-reputation';

// Phase 8 — drain-mode rate limit. For the first 24h after worker boot, cap
// on-chain writes at 1 per 60s so a backlog drain (e.g., the 10 unprocessed
// x402 events accumulated since 2026-05-14) doesn't burn gas in a burst.
// TODO(Phase 8.1, ~24h post-deploy): remove DRAIN_MODE_* state + the
// rate-limit branch in runOnce(). Steady-state has no need for a worker-
// level rate limit; per-event polling cadence (every 60s) is already 1/60s.
const FEEDBACK_LOOP_DRAIN_MODE_END_MS = Date.now() + 24 * 60 * 60 * 1000;
const FEEDBACK_LOOP_DRAIN_RATE_LIMIT_MS = 60_000;
let lastFeedbackWriteAt = 0;

// Phase 8 — circuit breaker mirror of Phase 7B/7C. After 5 consecutive
// ethers.js write failures (RPC slow / wallet OOG / contract revert) the
// worker sleeps 5min between attempts. Reset on first success.
const FEEDBACK_CIRCUIT_OPEN_THRESHOLD = 5;
const FEEDBACK_CIRCUIT_OPEN_SLEEP_MS = 5 * 60 * 1000;
let consecutiveFeedbackFailures = 0;
let circuitOpenUntil = 0;
let circuitOpenLogged = false;

// Phase 8 — bounded ethers.js call. RPC nodes (Base Sepolia public RPC,
// 'https://sepolia.base.org' default) CAN hang on network issues. ethers
// v6's contract methods don't natively accept AbortSignal, so use the same
// Promise.race + setTimeout-rejection pattern as Phase 7B's withQueryTimeout.
// 30s ceiling (longer than DB queries because on-chain confirmation
// inherently slower; 1-block wait on Base Sepolia ≈ 2s but the tx broadcast
// can sit in mempool). Per CLAUDE-RULE-8 NEVER UNBOUNDED WAIT.
const RPC_CALL_TIMEOUT_MS = 30_000;

function withRpcTimeout<T>(label: string, call: PromiseLike<T>, ms: number = RPC_CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`rpc timeout after ${ms}ms: ${label}`));
    }, ms);
    Promise.resolve(call).then(
      v => { clearTimeout(handle); resolve(v); },
      err => { clearTimeout(handle); reject(err); }
    );
  });
}

export class FeedbackLoopWorker {
  async runOnce(injectedWriter?: any) {
    // Phase 8 — circuit-open early-return. Suppress polling entirely during
    // cool-down. Resumes naturally on the next setInterval tick after the
    // window passes; first successful write resets the breaker.
    if (circuitOpenUntil > Date.now()) {
      return;
    }

    console.log('[FeedbackLoopWorker] Starting cycle...');

    // 1. Fetch unprocessed x402 events — PostgREST bypass (2026-05-21): direct
    //    pg SELECT in place of supabase-js. retries:1 (60s poll cadence; pgQuery
    //    owns the timeout + circuit breaker). The per-event writes further down
    //    (repid_agents read, repid_events/repid_agents updates) stay on
    //    supabase-js — low frequency, not in scope. RULE-8.
    let events: any[];
    try {
      // Defensive filters (2026-05-22): after Sean drained 990 stale events,
      // POLL_EVENT_FILTER_SQL keeps mock/simulated/orphaned rows out of the
      // poll so they can never reach the on-chain writer. See
      // feedback-loop-filters.ts (kept in sync with the JS guard below).
      events = await pgQuery(
        `SELECT * FROM repid_events
         WHERE event_type = ANY($1) AND processed_at IS NULL${POLL_EVENT_FILTER_SQL}
         LIMIT 50`,
        [['x402_inbound_settled', 'x402_outbound_settled', 'service_fulfilled_settled']],
        { retries: 1, label: 'feedback-loop:poll' }
      );
    } catch (e) {
      console.error('[FeedbackLoopWorker] Error fetching events:', e instanceof Error ? e.message : String(e));
      return;
    }

    if (!events || events.length === 0) {
      console.log('[FeedbackLoopWorker] No events to process.');
      return;
    }

    console.log(`[FeedbackLoopWorker] Processing ${events.length} events...`);

    const writer = injectedWriter || getReputationWriter();
    if (!writer) {
      console.warn('[FeedbackLoopWorker] Reputation writer not available (check env), skipping loop.');
      return;
    }


    for (const event of events) {
      try {
        const { subject_id, event_data } = event;

        // Defense-in-depth: re-check each row against the same rules as the SQL
        // poll filter. If the query is ever relaxed, this still blocks a
        // mock/simulated/orphaned event from a real on-chain write. Mark it
        // processed so it doesn't re-poll (RULE-11: error-checked).
        const gate = isEligibleForOnChainWrite(event);
        if (!gate.eligible) {
          console.warn(`[FeedbackLoopWorker] Skipping ineligible event ${event.id} (${gate.reason})`);
          const { error: skipErr } = await db
            .from('repid_events')
            .update({ processed_at: new Date().toISOString() })
            .eq('id', event.id);
          if (skipErr) {
            console.error(`[FeedbackLoopWorker] failed to mark ineligible event ${event.id} processed:`, skipErr.message ?? skipErr);
          }
          continue;
        }

        const { data: agent } = await db
          .from('repid_agents')
          .select('id, agent_name, current_repid, tier, erc8004_token_id')
          .eq('id', subject_id)
          .single();

        if (!agent) {
          console.warn(`[FeedbackLoopWorker] Agent ${subject_id} not found, skipping event ${event.id}`);
          continue;
        }

        // Tier check: only process for Established (1000+) tier.
        // Phase 8 — floor LOCKED at 1000 per Strategy Claude Pre-Diagnosis
        // ruling: EARNING too noisy for on-chain attestation cost.
        if (agent.current_repid < 1000) {
          console.log(`[FeedbackLoopWorker] Agent ${agent.agent_name} below Established tier (${agent.current_repid}), skipping...`);
          await db.from('repid_events').update({ processed_at: new Date().toISOString() }).eq('id', event.id);
          continue;
        }

        if (!agent.erc8004_token_id) {
          console.warn(`[FeedbackLoopWorker] Agent ${agent.agent_name} has no erc8004_token_id, skipping...`);
          // Mark processed to avoid infinite loops on un-minted agents
          await db.from('repid_events').update({ processed_at: new Date().toISOString() }).eq('id', event.id);
          continue;
        }

        // Phase 8 — drain-mode rate limit. For the first 24h after worker
        // boot, cap actual on-chain writes at 1 per 60s. Break out of the
        // batch loop when rate-limited; the next runOnce tick (60s cadence)
        // will pick up where we left off.
        // TODO(Phase 8.1, ~24h post-deploy): remove this branch.
        if (Date.now() < FEEDBACK_LOOP_DRAIN_MODE_END_MS) {
          const sinceLast = Date.now() - lastFeedbackWriteAt;
          if (lastFeedbackWriteAt > 0 && sinceLast < FEEDBACK_LOOP_DRAIN_RATE_LIMIT_MS) {
            console.log(`[FeedbackLoopWorker] drain-mode rate-limit: ${FEEDBACK_LOOP_DRAIN_RATE_LIMIT_MS - sinceLast}ms remaining — deferring event ${event.id} to next tick`);
            break;
          }
        }

        // 2. Perform on-chain write — bounded by withRpcTimeout per CLAUDE-RULE-8
        const feedbackHash = (event_data as any)?.tx_hash || (event_data as any)?.reputation_tx_hash || '0x0000000000000000000000000000000000000000000000000000000000000000';

        console.log(`[FeedbackLoopWorker] Writing RepID ${agent.current_repid} to chain for ${agent.agent_name} (token ${agent.erc8004_token_id})...`);

        const result: WriteRepIDResult = await withRpcTimeout<WriteRepIDResult>(
          `writeRepIDFeedback(${agent.agent_name},token=${agent.erc8004_token_id})`,
          writer.writeRepIDFeedback({
            agentTokenId: agent.erc8004_token_id,
            repid: Math.round(agent.current_repid),
            tier: agent.tier,
            endpoint: `https://trustrepid.dev/api/v1/agents/${agent.id}/reputation/payload.json`,
            feedbackURI: `https://trustrepid.dev/api/v1/agents/${agent.id}/reputation/payload.json`,
            feedbackHash
          })
        );
        lastFeedbackWriteAt = Date.now();

        // Phase 8 — successful write resets the circuit breaker
        if (consecutiveFeedbackFailures > 0 || circuitOpenLogged) {
          console.log(`[FeedbackLoopWorker] circuit-breaker reset after ${consecutiveFeedbackFailures} consecutive failures`);
          consecutiveFeedbackFailures = 0;
          circuitOpenLogged = false;
          circuitOpenUntil = 0;
        }

        console.log(`[FeedbackLoopWorker] RepID update confirmed for ${agent.agent_name}: ${result.txHash}`);

        // 3. Mark event as processed
        await db.from('repid_events').update({ 
          processed_at: new Date().toISOString(),
          event_data: { ...(event_data as any), reputation_tx_hash: result.txHash }
        }).eq('id', event.id);

        // 4. Update agent's last_reputation_tx_hash for fast-lookup
        await db.from('repid_agents').update({
          last_reputation_tx_hash: result.txHash
        }).eq('id', agent.id);

        // 5. Persist write record for audit trail
        await persistReputationWrite(db, {
          agent_id: agent.id,
          agent_token_id: agent.erc8004_token_id,
          repid_value: Math.round(agent.current_repid),
          tier: agent.tier,
          tx_hash: result.txHash,
          block_number: result.blockNumber,
          gas_used: result.gasUsed,
          chain_id: writer.chainId,
          contract_address: writer.getContractAddress()
        });

      } catch (e: any) {
        // Phase 8 — bounded-failure path. Increment circuit-breaker counter;
        // open the circuit once threshold crosses. Per-event error logs are
        // preserved verbatim from the pre-Phase-8 behavior (loud RULE-11).
        consecutiveFeedbackFailures += 1;
        console.error(`[FeedbackLoopWorker] Failed to process event ${event.id} (consecutive=${consecutiveFeedbackFailures}/${FEEDBACK_CIRCUIT_OPEN_THRESHOLD}):`, e.message);
        if (consecutiveFeedbackFailures >= FEEDBACK_CIRCUIT_OPEN_THRESHOLD && !circuitOpenLogged) {
          circuitOpenLogged = true;
          circuitOpenUntil = Date.now() + FEEDBACK_CIRCUIT_OPEN_SLEEP_MS;
          console.error(`[FeedbackLoopWorker] CIRCUIT OPEN — ${FEEDBACK_CIRCUIT_OPEN_THRESHOLD}+ consecutive failures; suppressing runOnce() for ${FEEDBACK_CIRCUIT_OPEN_SLEEP_MS}ms (5min) until cool-down`);
        }
      }
    }
  }

  start(intervalMs: number = 60000) {
    console.log(`[FeedbackLoopWorker] Worker started with interval ${intervalMs}ms, tier_floor=1000, rate_limit_drain_mode=${Date.now() < FEEDBACK_LOOP_DRAIN_MODE_END_MS}`);
    // Initial run immediately
    this.runOnce();
    // Schedule periodic runs
    setInterval(() => this.runOnce(), intervalMs);
  }
}

export const feedbackLoopWorker = new FeedbackLoopWorker();
