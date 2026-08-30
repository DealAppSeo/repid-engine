import type { SupabaseClient } from '@supabase/supabase-js';
import { pgQuery } from '../db/direct-pg';
import { buildPostcardCommitment, generateNonce } from '../zkp/commitment';
import { buildBoundStatement } from '../zkp/proof-statement-guard'; // corpus hygiene: fail-closed agent binding on every real-proof statement
import { resolveLeafDualWrite } from '../zkp/leaf-dual-write'; // backlog 4.2 (Inv-1): Poseidon2 leaf dual-write
import { easService } from './eas-attestation-service'; // S-ONCHAIN: EAS wiring for honest presentProof() (owned by XC)
import { routeProofRequest } from '../zkp/proof-router'; // S-ONCHAIN: routing classification (owned)
import type { RouteDecision } from '../zkp/proof-router';
// L4 breaker (consumer side): keep a restart from proving the internal-scoring
// churn backlog that #192 only stopped at the producer end. Default 'off'.
import {
  buildPendingBatchQuery,
  describeChurnGuard,
  parseProofDrainChurnMode,
  type ProofDrainChurnMode
} from './proof-drain-churn-guard';

export interface ProofDrainServiceConfig {
  supabase: SupabaseClient;
  zkpServiceUrl: string;
  pollIntervalMs?: number;
  idleSleepMs?: number;
  batchSize?: number;
  stallThresholdMs?: number;
  fetchImpl?: typeof fetch;
  // PostgREST bypass (2026-05-21) — injectable direct-pg query fn for the hot
  // fetchPendingBatch poll. Defaults to the real pgQuery; tests pass a mock.
  pgQueryImpl?: typeof pgQuery;
  // S-ONCHAIN routing-log classifier. routeProofRequest reaches the real `db`
  // singleton (not config.supabase), so without injection a unit test that mocks
  // supabase still makes a live DB round-trip here — under fake timers that hangs
  // the drain (proof-drain-service.test 5s timeout). Inject a stub in tests;
  // defaults to the real router so production behaviour is unchanged.
  routeProofRequestImpl?: (proofType: string, context?: { agentRepId?: number; sensitivityHint?: number }) => Promise<RouteDecision>;
  // L4 breaker: consumer-side churn guard. Defaults to PROOF_DRAIN_CHURN_MODE
  // (itself defaulting to 'off' = legacy). Injectable so tests never depend on
  // ambient env.
  churnMode?: ProofDrainChurnMode;
}

export interface ProofDrainServiceStatus {
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt: string | null;
  lastTickAt: string | null;
  lastDrainAt: string | null;
  jobsCompletedTotal: number;
  jobsFailedTotal: number;
  ticksTotal: number;
  lastError: { message: string; at: string } | null;
  zkpServiceUrl: string;
}

export interface ProofDrainService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): ProofDrainServiceStatus;
  drainOnce(): Promise<{ jobsCompleted: number; jobsFailed: number }>;
}

export const DEFAULT_PROOF_DRAIN_STALL_MS = 10 * 60 * 1000;

// Phase 7B (Unbounded Wait Disease) — broader exponential backoff so a slow
// upstream (Supabase compute degraded, prover hanging) doesn't translate into
// a tight retry storm. Previously: 3 attempts at 1s + 4s + 16s (max ~21s
// elapsed before throw + 10s idle sleep = ~31s per failure cycle, observed in
// production as the 14h+ retry storm of 2026-05-21). Now: 5 attempts with
// cap-at-256s tail (max ~341s elapsed before throw + cool-down).
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 4000, 16000, 64000, 256000];

// Phase 7B's withQueryTimeout helper (Promise.race over a supabase-js thenable)
// was removed 2026-05-21: fetchPendingBatch now uses direct pg via pgQuery,
// which owns its own per-attempt timeout + circuit breaker. The remaining
// supabase-js calls in this file (markCompleted/markFailed/insertCanonicalProof/
// fetchScore/emitStallHitl) are low-frequency and stay on supabase-js.

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 256000;
        console.warn(`[ProofDrain] ${label} attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed; retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export function createProofDrainService(config: ProofDrainServiceConfig): ProofDrainService {
  const pollIntervalMs = config.pollIntervalMs ?? 2000;
  const idleSleepMs = config.idleSleepMs ?? 10000;
  const batchSize = config.batchSize ?? 20;
  const stallThresholdMs = config.stallThresholdMs ?? DEFAULT_PROOF_DRAIN_STALL_MS;
  const httpFetch = config.fetchImpl ?? fetch;
  const pgq = config.pgQueryImpl ?? pgQuery;

  // A5 (D-062): when ON, the canonical repid_zkp_proofs insert also records the prover's REAL
  // scheme (proof_type, e.g. 'plonky3_range_check'), proof_bytes, statement {repid_score, threshold},
  // and — B-2 (Inv-1) — the aggregation-ready Poseidon2/BabyBear leaf + leaf_scheme lineage tag,
  // so each row is independently WASM-verifiable (hyperdag-proof-verifier) AND its leaf is foldable
  // by a future PACKAGE-tier proof — distinguishing real Plonky3 rows from legacy sha256 stubs.
  // Default OFF: behavior is byte-identical to today until the Plonky3 pin is deployed + A2/A3
  // re-verified on the pinned prover + the zkp-circuits-domain migration applied, then flip the flag.
  // New-events-only (no backfill of existing rows).
  const recordRealProofFields = (process.env.PROOF_DRAIN_RECORD_REAL_FIELDS ?? 'false').toLowerCase() === 'true';
  // RULE-8 (Unbounded Wait Disease, W1 fix): the prover httpFetch had no per-attempt
  // timeout, so a single hung prover call wedged the drain loop forever (the stall that
  // froze all proofs at 2026-06-07 09:58, right after the one real proof). Bound every
  // prover call with an AbortController; on abort it throws → withRetry backs off → the
  // circuit breaker trips, instead of the loop hanging.
  const proverTimeoutMs = Number(process.env.PROOF_DRAIN_PROVER_TIMEOUT_MS ?? 20000);
  const routeProof = config.routeProofRequestImpl ?? routeProofRequest;
  // L4 breaker (consumer side). 'off' by default → the hot poll runs the legacy
  // statement character-for-character. See proof-drain-churn-guard.ts for the
  // measured backlog composition this exists for.
  const churnMode: ProofDrainChurnMode = config.churnMode ?? parseProofDrainChurnMode(process.env.PROOF_DRAIN_CHURN_MODE);

  const state: ProofDrainServiceStatus = {
    status: 'stopped',
    startedAt: null,
    lastTickAt: null,
    lastDrainAt: null,
    jobsCompletedTotal: 0,
    jobsFailedTotal: 0,
    ticksTotal: 0,
    lastError: null,
    zkpServiceUrl: config.zkpServiceUrl
  };

  let loopTimer: NodeJS.Timeout | null = null;
  let tickInFlight = false;
  let stopped = false;

  let lastDrainAt = Date.now();
  let stallNotified = false;

  // Phase 7B (Unbounded Wait Disease cool-down) — circuit breaker. Tracks
  // consecutive `tick failed` outcomes. After CIRCUIT_OPEN_THRESHOLD
  // consecutive failures the loop sleeps CIRCUIT_OPEN_SLEEP_MS before the
  // next tick attempt (default 5min) instead of the usual idleSleepMs.
  // Reset to 0 on any successful tick (jobsCompleted + jobsFailed > 0 path
  // OR drainOnce returning a clean empty batch). Counter increments only in
  // tick's outer catch (drainOnce threw).
  const CIRCUIT_OPEN_THRESHOLD = 5;
  const CIRCUIT_OPEN_SLEEP_MS = 5 * 60 * 1000; // 5 minutes
  let consecutiveTickFailures = 0;
  let circuitOpenLogged = false;

  async function emitStallHitl(queueDepth: number, elapsedMs: number): Promise<void> {
    try {
      const { error } = await config.supabase.from('trinity_hitl_requests').insert({
        agent_id: 'service:proof-drain-worker',
        reason: 'worker_stalled',
        status: 'pending',
        context: {
          zkpServiceUrl: config.zkpServiceUrl,
          queueDepth,
          stallThresholdMs,
          elapsedMs,
          detectedAt: new Date().toISOString()
        }
      });
      if (error) {
        console.error('[ProofDrain] failed to write stall HITL request:', error.message);
        return;
      }
      console.warn(`[ProofDrain] STALL detected — no successful drain for ${elapsedMs}ms with queue_depth=${queueDepth}; HITL request raised`);
    } catch (err) {
      console.error('[ProofDrain] stall HITL emit threw:', err instanceof Error ? err.message : err);
    }
  }

  async function fetchPendingBatch(): Promise<Array<{ id: string; job_id: string; agent_id: string; event_id: string; status: string }>> {
    // PostgREST bypass (2026-05-21) — direct pg SELECT in place of the
    // supabase query builder. pgQuery owns the per-attempt timeout + circuit
    // breaker (RULE-8), so the Phase-7B withQueryTimeout wrapper is no longer
    // needed here; the drainOnce-level withRetry still provides outer retry, so
    // we keep retries:1 (single attempt) to preserve that structure.
    // L4 breaker: 'off' returns the legacy SQL + legacy 3 params verbatim.
    const plan = buildPendingBatchQuery(churnMode, {
      status: 'pending',
      zkpServiceUrl: config.zkpServiceUrl,
      batchSize
    });
    const rows = await pgq<{ id: string; job_id: string; agent_id: string; event_id: string; status: string; is_churn?: boolean }>(
      plan.sql,
      plan.params as any[],
      { retries: 1, label: 'fetchPendingBatch' }
    );
    // Shadow mode proves everything it fetches — the log is the whole point of it.
    if (plan.reportsChurn && !plan.excludesChurn) {
      const churnInBatch = rows.filter(r => r.is_churn === true).length;
      if (churnInBatch > 0) {
        console.warn(`[ProofDrain] churn-guard SHADOW — ${churnInBatch}/${rows.length} jobs in this batch are internal-scoring churn and WILL be proved (set PROOF_DRAIN_CHURN_MODE=enforce to exclude them)`);
      }
    }
    return rows;
  }

  async function fetchScore(eventId: string): Promise<number | null> {
    const { data, error } = await config.supabase
      .from('repid_score_events')
      .select('repid_after')
      .eq('id', eventId)
      .single();
    if (error || !data) return null;
    return Math.round((data as { repid_after: number }).repid_after);
  }

  /**
   * Phase 7 Gap B — canonical proof artifact write to repid_zkp_proofs.
   *
   * Non-fatal: any failure here is logged loudly but never thrown. The queue
   * UPDATE in markCompleted() is the primary truth; this insert is additive
   * evidence. A retry of markCompleted() must NOT re-run this insert (no
   * unique constraint on (agent_id, zk_commitment); we would create duplicate
   * rows). Hence the `try/catch` + log-only pattern.
   *
   * Schema mapping (verified Phase 7 against information_schema):
   *   - repid_zkp_proofs.proof_type    text NOT NULL, CHECK in {'POSTCARD','ENVELOPE','PACKAGE'}
   *   - repid_zkp_proofs.tier_proven   text NOT NULL  (PROBATIONARY|EARNING|ESTABLISHED|AUTONOMOUS|VETERAN)
   *   - repid_zkp_proofs.agent_id      uuid nullable
   *   - repid_zkp_proofs.merkle_root   text nullable
   *   - repid_zkp_proofs.zk_commitment text nullable
   *   - eas_attestation_uid            text nullable (V1.x will fill from EAS flow)
   *   - eas_schema                     defaults to 'constitutional-compliance-v1'
   *
   * proof_type mapping: the prover (zkp-postcard service) emits
   * proof_type='plonky3_range_check' or 'sha256_commitment_poc' — its
   * INTERNAL algorithm variant — neither of which satisfies the CHECK
   * constraint. Since both come from the zkp-postcard service (which produces
   * Postcard-tier proofs regardless of the inner algorithm), we always write
   * 'POSTCARD' here. The algorithm-variant info is preserved in proof_bytes
   * (binary format encodes its own version). Envelope/Package tiers will be
   * written by future provers (zkp-envelope, zkp-package).
   *
   * tier_proven: authoritative source is repid_agents.tier (kept in sync by
   * the trg_sync_tier Postgres trigger; do NOT trust the prover's tier field
   * — it's app-supplied per Sean's CLAUDE.md guidance). Fallback to
   * 'PROBATIONARY' if the agent row is missing, so we never violate the
   * NOT NULL constraint.
   */
  async function insertCanonicalProof(args: {
    agentId: string;
    commitment: string;
    merkleRoot: string | null;
    scheme?: string | null;
    proofBytes?: string | null;
    statement?: Record<string, unknown> | null;
    poseidon2Leaf?: string | null;
    leafScheme?: string | null;
    /**
     * PROVENANCE (2026-08-01). Until now a proof row carried only `agent_id`,
     * so it was a dead end: you could not ask which job produced it, which
     * score event it certifies, or which contract earned it. The queue row knew
     * all three; the proof did not, and nothing joined them.
     *
     * Carried through so a proof can be traced to the work that paid for it.
     * Read the honesty note on `statement` below before over-claiming what
     * this proves.
     */
    jobId?: string | null;
    eventId?: string | null;
    contractId?: string | null;
  }): Promise<void> {
    try {
      let tierProven = 'PROBATIONARY';
      try {
        const { data: agent } = await config.supabase
          .from('repid_agents')
          .select('tier')
          .eq('id', args.agentId)
          .maybeSingle();
        if (agent && (agent as any).tier) {
          tierProven = (agent as any).tier;
        } else {
          console.warn(`[ProofDrain] repid_agents row missing for ${args.agentId}; defaulting tier_proven=PROBATIONARY`);
        }
      } catch (e) {
        console.warn(`[ProofDrain] tier lookup threw for ${args.agentId}:`, e instanceof Error ? e.message : e);
      }

      // S-ONCHAIN Phase 3: log routing decision for this proof (even for drain output)
      const decision = await routeProof('POSTCARD', { agentRepId: tierProven === 'VETERAN' ? 8000 : 1000 });
      console.log(`[ProofDrain] routing for proof: ${decision.route_to} (${decision.reason})`);

      const insertRow: Record<string, unknown> = {
        agent_id: args.agentId,
        // Provenance. Nullable by design: a job with no event_id (the 22
        // dead-letter rows) legitimately has nothing to point at, and writing a
        // placeholder there would be inventing a link that does not exist.
        ...(args.jobId ? { job_id: args.jobId } : {}),
        // event_id IS DELIBERATELY OMITTED — the two columns disagree on type.
        //
        // MEASURED 2026-08-30: repid_proof_queue.event_id is BIGINT (it points at
        // repid_score_events), while repid_zkp_proofs.event_id is UUID. Sending the bigint
        // raises Postgres 42804 "column event_id is of type uuid but expression is of type
        // bigint", the whole INSERT is rejected, and the catch below swallows it while the
        // queue row stays `completed`.
        //
        // That is not hypothetical. This provenance block landed 2026-08-01 and has NEVER
        // succeeded: in every row of repid_zkp_proofs, job_id, event_id and contract_id are
        // populated ZERO times, and every completed job carries an event_id — so every
        // canonical write since has failed on this line, silently, for four weeks. The store's
        // newest row is 2026-08-01 06:58Z; the passport, CLI and badge have been serving it
        // while the prover kept minting real proofs into the queue every day, through today.
        //
        // CONTROLLED against the live table — three inserts, all rolled back:
        //     bare row (the pre-provenance shape) ............. INSERT_OK
        //     + job_id + contract_id .......................... INSERT_OK
        //     + event_id from a real completed queue row ...... 42804
        // event_id is the sole cause. The other two provenance columns are innocent, which is
        // why they stay: omitting event_id restores provenance rather than abandoning it.
        //
        // Omitting it restores the write NOW and keeps the two provenance columns whose types
        // do match. Recording event_id properly needs a migration aligning
        // repid_zkp_proofs.event_id to bigint (it is null on every existing row, so the change
        // is additive) — deliberately NOT bundled here, because a production column-type change
        // is a decision, and this fix should not wait on it.
        ...(args.contractId ? { contract_id: args.contractId } : {}),
        proof_type: 'POSTCARD',
        tier_proven: tierProven,
        merkle_root: args.merkleRoot,
        zk_commitment: args.commitment || null,
        // eas_attestation_uid: NULL — EAS flow is V1.x
        // eas_schema: defaults to 'constitutional-compliance-v1'
        // created_at: defaults to NOW()
      };
      // A5 (D-062), flag-gated: record the prover's real scheme/proof_bytes/statement so the
      // row is independently WASM-verifiable. Off by default → insert is byte-identical to before.
      if (recordRealProofFields) {
        if (args.scheme) insertRow.scheme = args.scheme;
        if (args.proofBytes) insertRow.proof_bytes = args.proofBytes;
        if (args.statement) insertRow.statement = args.statement;
        // B-2 (Inv-1): the aggregation-ready Poseidon2 leaf + its lineage tag. Same flag gate
        // as scheme/proof_bytes/statement — requires the 2026-06-08-zkp-circuits-domain migration
        // (adds poseidon2_leaf + leaf_scheme columns) to be applied first. Off by default.
        if (args.poseidon2Leaf) insertRow.poseidon2_leaf = args.poseidon2Leaf;
        if (args.leafScheme) insertRow.leaf_scheme = args.leafScheme;
      }
      const { error } = await config.supabase.from('repid_zkp_proofs').insert(insertRow as any);
      if (error) {
        // WHY THIS LOG IS SHAPED THIS WAY. Keeping the canonical insert non-fatal is the right
        // call — a job that produced a real proof should not be marked failed because an
        // additive evidence row did not land. But "non-fatal" was implemented as "invisible",
        // and the two are not the same thing.
        //
        // MEASURED 2026-08-30: this branch fired on EVERY canonical write for three weeks
        // (Postgres 42804, event_id uuid vs bigint — fixed above). Throughout, the queue
        // reported `completed`, /health reported nothing, and the passport kept serving a
        // three-week-old proof. A console line in a Railway log is not an alarm; nothing
        // reads it, and no surface anywhere said the store had stopped accepting writes.
        //
        // So: a stable, greppable marker plus the Postgres code, and — the part that actually
        // matters — a divergence anyone can query without reading logs at all:
        //
        //   select count(*) from repid_proof_queue q
        //    where q.status='completed'
        //      and not exists (select 1 from repid_zkp_proofs z where z.job_id = q.job_id);
        //
        // That query is the real detector. It was answerable on day one and nobody had reason
        // to ask it, because every visible signal said the pipeline was healthy.
        console.error(
          `[ProofDrain][CANONICAL_WRITE_FAILED] repid_zkp_proofs INSERT rejected for agent=${args.agentId} ` +
            `job=${args.jobId ?? 'none'} pgcode=${(error as { code?: string }).code ?? 'unknown'} — ` +
            `the proof EXISTS in repid_proof_queue but is NOT readable by passport/CLI/badge. ` +
            `Queue deliberately stays 'completed' (the proof is real); this row is the missing evidence.`,
          error.message,
          error
        );
      } else if (args.merkleRoot) {
        // S-ONCHAIN Phase 2: wire real EAS on Base Sepolia for qualifying proofs (those with merkle_root from drain, e.g. tier promotions).
        // Gate: only threshold/anchored ones to control cost. Update row with uid + schema so presentProof() can return honest on-chain ref.
        try {
          const res = await easService.attestProof({
            proofId: 0,
            agentId: args.agentId,
            tier: tierProven,
            merkleRoot: args.merkleRoot,
            repidSnapshot: 0,
            proofType: 'POSTCARD'
          });
          const uid = res?.uid;
          if (uid && !uid.startsWith('0x0000')) {
            await config.supabase.from('repid_zkp_proofs')
              .update({ eas_attestation_uid: uid, eas_schema: 'constitutional-compliance-v1' })
              .eq('agent_id', args.agentId)
              .eq('merkle_root', args.merkleRoot);
            console.log(`[ProofDrain] EAS attested for ${args.agentId}: ${uid}`);
          }
        } catch (easErr: any) {
          console.warn(`[ProofDrain] EAS attest skipped/failed for ${args.agentId}: ${easErr?.message || easErr} (fund EAS_ATTESTER_PRIVATE_KEY on Base Sepolia)`);
        }
      }

      // R3: EAS real-ready wire (only merkle/HyperDAG). Non-fatal. Uses our service (no borrowed).
      if (args.merkleRoot) {
        try {
          const { easService } = await import('./eas-attestation-service.js');
          if (easService.hasAttesterKey()) {
            const res = await easService.attestProof({
              proofId: 0,
              agentId: args.agentId,
              tier: tierProven,
              merkleRoot: args.merkleRoot,
              repidSnapshot: null,
              proofType: 'POSTCARD'
            });
            if (res.uid) {
              await config.supabase.from('repid_zkp_proofs')
                .update({ eas_attestation_uid: res.uid, eas_schema: 'constitutional-compliance-v1' })
                .eq('zk_commitment', args.commitment)
                .is('eas_attestation_uid', null);
              console.log(`[ProofDrain][R3-EAS] uid=${res.uid} agent=${args.agentId}`);
            }
          }
        } catch (e: any) {
          console.warn('[ProofDrain][R3-EAS] non-fatal:', e?.message || e);
        }
      }

      // W3 (2026-06-08) — continuous EAS anchoring for REAL proofs. The two blocks above
      // only fire when the prover returns a merkle_root (the 05-30 batch); real plonky3
      // proofs carry a zk_commitment but no merkle_root, so they never anchored — only 5
      // attestations exist. Anchor each new real proof by its commitment (a 32-byte proof
      // identity that fits the schema's bytes32 merkleRoot field). Gated by
      // EAS_CONTINUOUS_ANCHOR_ENABLED (default OFF → no on-chain fire at merge / per the
      // "don't fire" discipline) and the attester key being present. RULE-8: bounded.
      if (
        !error &&
        process.env.EAS_CONTINUOUS_ANCHOR_ENABLED === 'true' &&
        recordRealProofFields &&
        args.scheme && args.proofBytes && args.commitment && !args.merkleRoot
      ) {
        let anchorTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const { easService } = await import('./eas-attestation-service.js');
          if (easService.hasAttesterKey()) {
            const anchorTimeoutMs = Number(process.env.EAS_ANCHOR_TIMEOUT_MS ?? 30000);
            const res = (await Promise.race([
              easService.attestProof({
                proofId: 0,
                agentId: args.agentId,
                tier: tierProven,
                merkleRoot: args.commitment, // commitment as the 32-byte proof anchor
                repidSnapshot: null,
                proofType: args.scheme,
              }),
              new Promise((_, rej) => {
                anchorTimer = setTimeout(
                  () => rej(new Error(`EAS continuous anchor timeout after ${anchorTimeoutMs}ms`)),
                  anchorTimeoutMs,
                );
              }),
            ])) as { uid: string | null };
            if (res?.uid && !res.uid.startsWith('0x0000')) {
              await config.supabase.from('repid_zkp_proofs')
                .update({ eas_attestation_uid: res.uid, eas_schema: 'constitutional-compliance-v1' })
                .eq('zk_commitment', args.commitment)
                .is('eas_attestation_uid', null);
              console.log(`[ProofDrain][W3-EAS] continuous anchor uid=${res.uid} agent=${args.agentId} scheme=${args.scheme}`);
            }
          }
        } catch (e: any) {
          console.warn('[ProofDrain][W3-EAS] continuous anchor non-fatal:', e?.message || e);
        } finally {
          if (anchorTimer) clearTimeout(anchorTimer); // RULE-8: release the timer
        }
      }
    } catch (e) {
      console.error(
        `[ProofDrain] insertCanonicalProof threw for ${args.agentId} (queue stays completed):`,
        e instanceof Error ? e.message : e,
        e instanceof Error ? e.stack : undefined
      );
    }
  }

  /**
   * Phase 7 Gap A — markCompleted now persists proof_bytes + proof_size_bytes
   * onto the queue row (the bytes were being discarded pre-Phase-7: 1 of
   * 2716 completed queue rows had proof_bytes populated, the rest were
   * NULL because this UPDATE list omitted them). Followed by Gap B's
   * canonical insert to repid_zkp_proofs.
   */
  async function markCompleted(args: {
    rowId: string;
    agentId: string;
    proofHash: string;
    proofBytes: string | null;
    proofSizeBytes: number | null;
    commitment: string;
    merkleRoot: string | null;
    scheme?: string | null;
    statement?: Record<string, unknown> | null;
    poseidon2Leaf?: string | null;
    leafScheme?: string | null;
    /** Provenance carried from the queue row — see insertCanonicalProof. */
    jobId?: string | null;
    eventId?: string | null;
    contractId?: string | null;
  }): Promise<void> {
    const { error } = await config.supabase
      .from('repid_proof_queue')
      .update({
        status: 'completed',
        proof_hash: args.proofHash,
        proof_bytes: args.proofBytes,
        proof_size_bytes: args.proofSizeBytes,
        completed_at: new Date().toISOString()
      })
      .eq('id', args.rowId);
    if (error) throw new Error(`mark completed failed: ${error.message}`);

    // Gap B — additive evidence insert. Non-fatal; never throws.
    await insertCanonicalProof({
      agentId: args.agentId,
      commitment: args.commitment,
      merkleRoot: args.merkleRoot,
      scheme: args.scheme ?? null,
      proofBytes: args.proofBytes,
      statement: args.statement ?? null,
      poseidon2Leaf: args.poseidon2Leaf ?? null,
      leafScheme: args.leafScheme ?? null,
      jobId: args.jobId ?? null,
      eventId: args.eventId ?? null,
      contractId: args.contractId ?? null,
    });

    // Write through to Dragonfly proof cache and zkp_proofs_staged table
    try {
      const { cacheStagedProof } = require('../cache/proof-cache');
      const { data: agent } = await config.supabase
        .from('repid_agents')
        .select('agent_name')
        .eq('id', args.agentId)
        .maybeSingle();
      const agentName = agent?.agent_name || args.agentId;

      await cacheStagedProof({
        proof_type: 'POSTCARD',
        agent_name: agentName,
        proof_data: args.proofBytes ? Buffer.from(args.proofBytes, 'base64').toString('hex') : '',
        proof_hash: args.proofHash,
        merkle_root: args.merkleRoot || '',
        anchor_tx_hash: args.commitment || '',
        status: 'valid',
      });
    } catch (cacheErr) {
      console.warn('[ProofDrain] Failed to cache staged proof:', cacheErr);
    }
  }

  async function markFailed(rowId: string, message: string): Promise<void> {
    const { error } = await config.supabase
      .from('repid_proof_queue')
      .update({ status: 'failed', error_message: message })
      .eq('id', rowId);
    if (error) {
      console.error('[ProofDrain] mark failed update errored:', error.message);
    }
  }

  async function processJob(job: { id: string; job_id: string; agent_id: string; event_id: string }): Promise<'completed' | 'failed'> {
    const score = await withRetry(`fetchScore[${job.event_id}]`, () => fetchScore(job.event_id));
    if (score === null) {
      await markFailed(job.id, 'Score event not found');
      return 'failed';
    }

    // Per-proof nonce (sprint 2026-05-29 Part B) — generated ONCE before the
    // retry loop so retries of the same job reuse it (idempotent). Sent to the
    // prover so a nonce-aware prover binds it, AND folded into the stored
    // commitment below to guarantee uniqueness regardless of the prover.
    const nonce = generateNonce();
    const res = await withRetry(`zkp.prove[${job.job_id}]`, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), proverTimeoutMs);
      try {
        const r = await httpFetch(`${config.zkpServiceUrl}/zkp/repid-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: job.agent_id,
            score,
            nonce,
            metadata: { job_id: job.job_id }
          }),
          signal: controller.signal
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}: ${text}`);
        }
        return r;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          throw new Error(`prover timeout after ${proverTimeoutMs}ms (zkp.prove[${job.job_id}])`);
        }
        throw e;
      } finally {
        clearTimeout(timer); // RULE-8: release the timer regardless of outcome
      }
    });

    // Phase 7 Gap A — parse the FULL prover response (was discarding everything
    // but commitment/hash). Prover JSON shape per the zkp-postcard service:
    //   { proof_type, tier, commitment, proof_bytes, proof_size_bytes?, merkle_root? }
    const proof = (await res.json()) as {
      commitment?: string;
      proof_hash?: string;
      hash?: string;
      proof_bytes?: string;
      proof_size_bytes?: number;
      proof_type?: string;
      tier?: string;
      merkle_root?: string;
      public_statement?: string;
      repid_score_actual?: number;
      // B-2 (Inv-1): aggregation-ready Poseidon2/BabyBear leaf + its lineage tag, emitted by the
      // leaf-aware prover ('poseidon2_babybear'). Empty on the sha256 fallback path.
      poseidon2_leaf?: string;
      leaf_scheme?: string;
    };
    const proofHash = proof.commitment ?? proof.proof_hash ?? proof.hash ?? '';
    const commitment = proof.commitment ?? '';
    const proofBytes = typeof proof.proof_bytes === 'string' ? proof.proof_bytes : null;
    // Prefer the prover's declared size; fall back to a Base64-length estimate
    // when bytes are present but the size field isn't (the prior 2716/2642 row
    // distribution shows size was sometimes populated independently — preserve
    // that signal when available).
    const proofSizeBytes =
      typeof proof.proof_size_bytes === 'number'
        ? proof.proof_size_bytes
        : proofBytes
          ? Math.ceil((proofBytes.length * 3) / 4)
          : null;
    const merkleRoot = typeof proof.merkle_root === 'string' ? proof.merkle_root : null;

    // A5 (D-062): capture the prover's real scheme + statement so the canonical row is
    // independently WASM-verifiable. Only a real Plonky3 proof gets a statement; threshold
    // parsed from the prover's public_statement ("RepID > N"). repid_score is the prover's
    // server-side actual (it ignores client score).
    //
    // CORPUS HYGIENE (2026-08-09): the statement MUST bind the agent, not just carry
    // {repid_score, threshold}. 7,958 of 22,239 "real" rows were persisted agent-less
    // (score defaulted to 1000), inflating the real-proof count and failing the WASM
    // verifier ("missing field agent_id"/"tier"). buildBoundStatement is fail-closed: an
    // empty agent_id throws here → the job is marked failed → NO unbound proof is minted.
    // job.agent_id is the real custodied agent uuid for every queue row, so a live drain
    // always yields a bound 4-key statement; the tier is derived from the proven score
    // (matching zkp-audit-service.buildCompleteStatement).
    const scheme = typeof proof.proof_type === 'string' ? proof.proof_type : null;
    const thrMatch = typeof proof.public_statement === 'string' ? proof.public_statement.match(/(\d+)/) : null;
    const statementScore = typeof proof.repid_score_actual === 'number' ? proof.repid_score_actual : score;
    const statement =
      scheme === 'plonky3_range_check' && thrMatch
        ? buildBoundStatement({
            agentId: job.agent_id,
            repidScore: statementScore,
            threshold: Number(thrMatch[1]),
          })
        : null;

    // Bind the per-proof nonce into the stored canonical commitment so every
    // proof's zk_commitment is unique (root-cause fix: was deterministic per
    // agent → 18.1% unique). The prover's commitment is bound in too, preserving
    // the tie to the proof. proof_hash on the queue stays the prover's value.
    const uniqueCommitment = buildPostcardCommitment({
      agentId: job.agent_id,
      score,
      tier: typeof proof.tier === 'string' ? proof.tier : '',
      nonce,
      proverCommitment: commitment,
    });

    // B-2 (Inv-1) / backlog 4.2 — the aggregation-ready Poseidon2 leaf + lineage tag.
    // Stored in its OWN column, never in zk_commitment (which stays nonce-bound for row
    // uniqueness, and which the 220 on-chain keccak256 merkle anchors already commit to).
    //
    // Source order: a leaf-aware prover's own `poseidon2_leaf` wins outright; otherwise the
    // engine derives it with the parity-gated TS hash (4.0-c). Deliberately computed AFTER
    // `uniqueCommitment` so the leaf is taken over the EXACT string that lands in
    // zk_commitment — i.e. it equals `merkle-root.ts`'s `poseidon2` scheme leaf for this row,
    // which is what makes the column foldable by a future PACKAGE-tier proof rather than
    // merely populated. Mode is off/shadow/on, default OFF ⇒ byte-identical to before.
    const leafWrite = resolveLeafDualWrite(
      uniqueCommitment,
      proof.poseidon2_leaf,
      proof.leaf_scheme
    );
    const poseidon2Leaf = leafWrite.leaf;
    const leafScheme = leafWrite.scheme;

    await withRetry(`markCompleted[${job.id}]`, () =>
      markCompleted({
        rowId: job.id,
        agentId: job.agent_id,
        proofHash,
        proofBytes,
        proofSizeBytes,
        commitment: uniqueCommitment,
        merkleRoot,
        scheme,
        statement,
        poseidon2Leaf,
        leafScheme,
        // Provenance from the queue row the prover was run for. contract_id is
        // read off the job (backfilled from repid_score_events), so a proof can
        // finally be traced to the contract that paid for it.
        jobId: job.job_id ?? null,
        eventId: (job as { event_id?: string | null }).event_id ?? null,
        contractId: (job as { contract_id?: string | null }).contract_id ?? null,
      })
    );
    return 'completed';
  }

  async function drainOnce(): Promise<{ jobsCompleted: number; jobsFailed: number }> {
    const jobs = await withRetry('fetchPendingBatch', fetchPendingBatch);
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        const outcome = await processJob(job);
        if (outcome === 'completed') completed++;
        else failed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(job.id, message);
        failed++;
      }
    }
    return { jobsCompleted: completed, jobsFailed: failed };
  }

  async function tick(): Promise<number> {
    if (tickInFlight) return 0;
    tickInFlight = true;
    try {
      const { jobsCompleted, jobsFailed } = await drainOnce();
      state.lastTickAt = new Date().toISOString();
      state.jobsCompletedTotal += jobsCompleted;
      state.jobsFailedTotal += jobsFailed;
      state.ticksTotal += 1;
      // Phase 7B circuit-breaker — drainOnce returned without throwing,
      // so the tick "succeeded" (regardless of per-job pass/fail). Reset
      // the consecutive-failure counter and re-arm the open-log gate.
      if (consecutiveTickFailures > 0 || circuitOpenLogged) {
        console.log(`[ProofDrain] circuit-breaker reset — tick succeeded after ${consecutiveTickFailures} consecutive failures`);
        consecutiveTickFailures = 0;
        circuitOpenLogged = false;
      }
      if (jobsCompleted > 0) {
        state.lastDrainAt = new Date().toISOString();
        lastDrainAt = Date.now();
        stallNotified = false;
        console.log(`[ProofDrain] tick +${jobsCompleted} completed, ${jobsFailed} failed`);
      } else {
        const queueDepth = jobsFailed;
        const now = Date.now();
        if (queueDepth > 0 && !stallNotified && now - lastDrainAt > stallThresholdMs) {
          stallNotified = true;
          await emitStallHitl(queueDepth, now - lastDrainAt);
        }
      }
      return jobsCompleted + jobsFailed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = { message, at: new Date().toISOString() };
      consecutiveTickFailures += 1;
      console.error(`[ProofDrain] tick failed (consecutive=${consecutiveTickFailures}/${CIRCUIT_OPEN_THRESHOLD}):`, message);
      if (consecutiveTickFailures >= CIRCUIT_OPEN_THRESHOLD && !circuitOpenLogged) {
        circuitOpenLogged = true;
        console.error(`[ProofDrain] CIRCUIT OPEN — ${CIRCUIT_OPEN_THRESHOLD}+ consecutive tick failures; sleeping ${CIRCUIT_OPEN_SLEEP_MS}ms (5min) between tick attempts until upstream recovers`);
      }
      return 0;
    } finally {
      // Phase 7B safety net — tickInFlight MUST be released even on synchronous
      // throw, abort propagation, or process-level interrupts that re-enter
      // the JS event loop. finally runs regardless of how try/catch exits.
      tickInFlight = false;
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const processed = await tick();
      // Phase 7B — sleep choice (in order):
      //  1. Circuit open (≥ CIRCUIT_OPEN_THRESHOLD consecutive failures):
      //     CIRCUIT_OPEN_SLEEP_MS (5min) — give upstream time to recover.
      //  2. Work done this tick: pollIntervalMs (default 2s).
      //  3. Idle/no-work: idleSleepMs (default 10s).
      let sleepMs: number;
      if (consecutiveTickFailures >= CIRCUIT_OPEN_THRESHOLD) {
        sleepMs = CIRCUIT_OPEN_SLEEP_MS;
      } else if (processed > 0) {
        sleepMs = pollIntervalMs;
      } else {
        sleepMs = idleSleepMs;
      }
      await new Promise<void>(resolve => {
        loopTimer = setTimeout(resolve, sleepMs);
      });
    }
  }

  return {
    async start() {
      if (state.status === 'running') return;
      state.status = 'starting';
      state.startedAt = new Date().toISOString();
      lastDrainAt = Date.now();
      stallNotified = false;
      stopped = false;
      console.log(`[ProofDrain] starting service zkp=${config.zkpServiceUrl} (poll=${pollIntervalMs}ms, idle=${idleSleepMs}ms, batch=${batchSize})`);
      // Fail-loud: a restart that forgot the lever says so in the first lines of its log.
      console.log(describeChurnGuard(churnMode));
      state.status = 'running';
      void loop();
    },

    async stop() {
      stopped = true;
      if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
      state.status = 'stopped';
    },

    getStatus() {
      return { ...state };
    },

    drainOnce
  };
}
