/**
 * EAS Anchor Worker — anchors REAL, un-anchored Plonky3 proofs to Base Sepolia
 * EAS in merkle batches, and keeps anchoring new real proofs on a schedule.
 * ============================================================================
 *
 * THE GAP THIS CLOSES
 * -------------------
 * repid_zkp_proofs has 21,960 rows with is_real=true AND eas_attestation_uid
 * IS NULL (verified 2026-07-04). The per-proof EAS wiring in proof-drain-service
 * only fires on the narrow merkle_root path (or the flag-gated W3 continuous
 * path); the bulk of real proofs carry a zk_commitment but were never anchored.
 * The epoch anchorer (zkp-epoch-anchor.ts) can aggregate + anchor but is
 * day/POSTCARD-scoped and has NO call site. This worker is the missing call
 * site for the general is_real un-anchored set: it batches un-anchored real
 * proofs by count, merkle-aggregates them, posts ONE EAS attestation per batch,
 * and writes the uid + tx hash back onto every proof row in the batch.
 *
 * REUSE (no new crypto):
 *   - merkle aggregation: rootFromCommitments() from src/zkp/merkle-root.ts —
 *     the SAME hash-agnostic builder zkp-epoch-anchor uses (keccak256 default).
 *   - EAS post: easService.attestProof() / hasAttesterKey() from
 *     src/services/eas-attestation-service.ts — posts a bytes32 merkle root to
 *     Base Sepolia EAS, returns { uid, txHash }, key-missing = error (no throw).
 * This worker adds NO merkle and NO on-chain logic of its own.
 *
 * LIVENESS: system_liveness_v's `eas_anchoring` lane =
 *   max(created_at) WHERE eas_attestation_uid IS NOT NULL
 * (verified 2026-07-04). Writing the uid back onto proof rows IS the liveness
 * signal — no separate last_anchor_at write is needed.
 *
 * SAFETY / CONTROL
 * ----------------
 *   - Disabled by default. EAS_ANCHOR_WORKER_ENABLED=true to activate.
 *   - Requires the attester key present (HYPERDAG_ATTESTOR_PRIVATE_KEY /
 *     EAS_ATTESTER_PRIVATE_KEY). If absent: DEGRADE LOUDLY (markDegraded + warn)
 *     and no-op — never a silent stub.
 *   - Two modes: BACKFILL (drain all un-anchored real proofs in batches, logs a
 *     tx-count / cost ESTIMATE before it would send) and SCHEDULED (poll every
 *     N minutes for new un-anchored real proofs). Both call the same runBatch().
 *   - Per-batch size cap (default 100). Backfill has an optional max-batch cap so
 *     a run is bounded.
 *   - On-chain send is real via easService but only fires when the key is present
 *     AND the worker is enabled; with no key it stops at the degraded no-op.
 *     NOTE: no key is available in CI / local — tsc + unit tests use a mock.
 */

import { db as realDb } from '../db';
import { pgQuery as realPgQuery } from '../db/direct-pg';
import { easService as realEasService } from '../services/eas-attestation-service';
import { rootFromCommitments, DEFAULT_HASH_SCHEME } from '../zkp/merkle-root';
import { markDegraded } from '../lib/degraded';

/* -------------------------------------------------------------------------- */
/* Types + injectable dependencies (so unit tests need no network / DB)        */
/* -------------------------------------------------------------------------- */

/** One un-anchored real proof row (batch-selection projection). */
export interface UnanchoredProofRow {
  id: number;
  agent_id: string | null;
  tier_proven: string;
  zk_commitment: string;
}

/** Minimal EAS surface this worker needs — matches easService. */
export interface EasClient {
  hasAttesterKey(): boolean;
  attestProof(input: {
    proofId: number;
    agentId: string;
    tier: string;
    merkleRoot: string;
    repidSnapshot?: number | null;
    proofType?: string;
  }): Promise<{ uid: string | null; txHash: string | null; error?: string }>;
}

/** Minimal Supabase surface (only the batch-audit insert). */
export interface BatchAuditSink {
  insertBatchRow(row: {
    merkle_root: string;
    hash_scheme: string;
    tx_hash: string | null;
    eas_uid: string | null;
    eas_schema: string | null;
    proof_id_min: number;
    proof_id_max: number;
    proof_count: number;
    proof_ids: number[];
    status: 'anchored' | 'deferred' | 'failed';
    error?: string | null;
  }): Promise<{ error: string | null }>;
}

export interface EasAnchorWorkerDeps {
  /** Batch selection (direct pg, hot path). Defaults to the real pgQuery. */
  pgQueryImpl?: typeof realPgQuery;
  /** Writeback of uid/tx onto the proof rows. Defaults to the real pgQuery. */
  writebackImpl?: typeof realPgQuery;
  /** EAS client. Defaults to the real easService. */
  easClient?: EasClient;
  /** Batch-audit sink. Defaults to a Supabase-backed insert into eas_anchor_batches. */
  auditSink?: BatchAuditSink;
  /** Hash scheme name (keccak256 default — byte-identical to zkp-epoch-anchor). */
  hashScheme?: string;
  /** Batch size (rows per EAS attestation). Default 100. */
  batchSize?: number;
}

export interface RunBatchResult {
  status: 'anchored' | 'deferred' | 'degraded' | 'no_work';
  batchCount: number;
  merkleRoot: string | null;
  easUid: string | null;
  txHash: string | null;
  proofIdMin: number | null;
  proofIdMax: number | null;
  rowsWrittenBack: number;
  reason?: string;
}

export const EAS_ANCHOR_SCHEMA_LABEL = 'repid-real-proof-batch-v1';
const DEFAULT_BATCH_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* Default Supabase-backed audit sink                                          */
/* -------------------------------------------------------------------------- */

function defaultAuditSink(): BatchAuditSink {
  return {
    async insertBatchRow(row) {
      const { error } = await realDb.from('eas_anchor_batches').insert(row as any);
      return { error: error ? error.message : null };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Core: select → merkle → attest → writeback → audit                          */
/* -------------------------------------------------------------------------- */

export class EasAnchorWorker {
  private readonly pgQuery: typeof realPgQuery;
  private readonly writeback: typeof realPgQuery;
  private readonly eas: EasClient;
  private readonly audit: BatchAuditSink;
  private readonly hashScheme: string;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: EasAnchorWorkerDeps = {}) {
    this.pgQuery = deps.pgQueryImpl ?? realPgQuery;
    this.writeback = deps.writebackImpl ?? deps.pgQueryImpl ?? realPgQuery;
    this.eas = deps.easClient ?? realEasService;
    this.audit = deps.auditSink ?? defaultAuditSink();
    this.hashScheme = deps.hashScheme ?? DEFAULT_HASH_SCHEME;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Count of un-anchored real proofs still to anchor (for the backfill estimate). */
  async unanchoredCount(): Promise<number> {
    const rows = await this.pgQuery<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM repid_zkp_proofs
        WHERE is_real = true
          AND eas_attestation_uid IS NULL
          AND zk_commitment IS NOT NULL`,
      [],
      { retries: 2, label: 'eas-anchor-unanchored-count' },
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Select the next batch of un-anchored real proofs, oldest first. */
  async selectBatch(): Promise<UnanchoredProofRow[]> {
    return this.pgQuery<UnanchoredProofRow>(
      `SELECT id, agent_id, tier_proven, zk_commitment
         FROM repid_zkp_proofs
        WHERE is_real = true
          AND eas_attestation_uid IS NULL
          AND zk_commitment IS NOT NULL
        ORDER BY created_at ASC, id ASC
        LIMIT $1`,
      [this.batchSize],
      { retries: 2, label: 'eas-anchor-select-batch' },
    );
  }

  /** Merkle root over a batch's commitments (REUSED builder, keccak256 default). */
  buildBatchRoot(rows: UnanchoredProofRow[]): { root: string; scheme: string } {
    const commitments = rows.map((r) => r.zk_commitment);
    const { root, scheme } = rootFromCommitments(commitments, this.hashScheme);
    return { root, scheme };
  }

  /**
   * Writeback: stamp eas_attestation_uid + eas_schema onto every proof row in
   * the batch (by id). This is the liveness signal system_liveness_v reads.
   */
  async writebackUid(ids: number[], uid: string): Promise<number> {
    const updated = await this.writeback<{ id: number }>(
      `UPDATE repid_zkp_proofs
          SET eas_attestation_uid = $1, eas_schema = $2
        WHERE id = ANY($3::bigint[])
          AND eas_attestation_uid IS NULL
        RETURNING id`,
      [uid, EAS_ANCHOR_SCHEMA_LABEL, ids],
      { retries: 2, label: 'eas-anchor-writeback-uid' },
    );
    return updated.length;
  }

  /**
   * Run one batch: select → merkle → attest → writeback → audit.
   * - No key present  → degrade loudly, no-op (status 'degraded').
   * - No un-anchored  → status 'no_work'.
   * - attestProof err → status 'deferred', audit row status 'failed', no writeback.
   * - success         → status 'anchored', writeback + audit row 'anchored'.
   */
  async runBatch(): Promise<RunBatchResult> {
    if (!this.eas.hasAttesterKey()) {
      const r = markDegraded(
        {
          status: 'degraded' as const,
          batchCount: 0,
          merkleRoot: null,
          easUid: null,
          txHash: null,
          proofIdMin: null,
          proofIdMax: null,
          rowsWrittenBack: 0,
        },
        'attester key missing (HYPERDAG_ATTESTOR_PRIVATE_KEY / EAS_ATTESTER_PRIVATE_KEY) — no EAS post, no writeback',
        'eas-anchor',
      );
      return { ...r, reason: r.degraded_reason };
    }

    const rows = await this.selectBatch();
    if (rows.length === 0) {
      return {
        status: 'no_work', batchCount: 0, merkleRoot: null, easUid: null, txHash: null,
        proofIdMin: null, proofIdMax: null, rowsWrittenBack: 0,
      };
    }

    const ids = rows.map((r) => r.id);
    const proofIdMin = Math.min(...ids);
    const proofIdMax = Math.max(...ids);
    const { root, scheme } = this.buildBatchRoot(rows);

    // One EAS attestation per batch — root as the bytes32 merkleRoot field.
    // agentId/tier reference the batch representative (first row); the root is
    // what's cryptographically anchored. proofId=proofIdMin as a stable ref.
    const rep = rows[0]!;
    const res = await this.eas.attestProof({
      proofId: proofIdMin,
      agentId: rep.agent_id ?? '',
      tier: rep.tier_proven,
      merkleRoot: root,
      repidSnapshot: null,
      proofType: 'REAL_PROOF_BATCH',
    });

    if (!res.uid || res.error) {
      // Attest did not yield a uid (e.g. broadcast failed). Deferred; audit the
      // attempt as failed, do NOT write back (rows stay un-anchored, retried).
      await this.audit.insertBatchRow({
        merkle_root: root, hash_scheme: scheme, tx_hash: res.txHash ?? null,
        eas_uid: null, eas_schema: EAS_ANCHOR_SCHEMA_LABEL,
        proof_id_min: proofIdMin, proof_id_max: proofIdMax,
        proof_count: rows.length, proof_ids: ids, status: 'failed',
        error: res.error ?? 'attest returned no uid',
      });
      return {
        status: 'deferred', batchCount: rows.length, merkleRoot: root, easUid: null,
        txHash: res.txHash ?? null, proofIdMin, proofIdMax, rowsWrittenBack: 0,
        reason: res.error ?? 'attest returned no uid',
      };
    }

    const rowsWrittenBack = await this.writebackUid(ids, res.uid);
    const auditRes = await this.audit.insertBatchRow({
      merkle_root: root, hash_scheme: scheme, tx_hash: res.txHash ?? null,
      eas_uid: res.uid, eas_schema: EAS_ANCHOR_SCHEMA_LABEL,
      proof_id_min: proofIdMin, proof_id_max: proofIdMax,
      proof_count: rows.length, proof_ids: ids, status: 'anchored',
    });
    if (auditRes.error) {
      // Non-fatal: the writeback (liveness) already landed. Audit row is
      // additive; log loud rather than throw (RULE-8 spirit).
      console.error(`[eas-anchor] batch audit insert failed (writeback OK): ${auditRes.error}`);
    }

    console.log(
      `[eas-anchor] anchored batch: ${rows.length} proofs (id ${proofIdMin}..${proofIdMax}) ` +
        `root=${root} uid=${res.uid} tx=${res.txHash ?? 'n/a'} wroteBack=${rowsWrittenBack}`,
    );

    return {
      status: 'anchored', batchCount: rows.length, merkleRoot: root, easUid: res.uid,
      txHash: res.txHash ?? null, proofIdMin, proofIdMax, rowsWrittenBack,
    };
  }

  /**
   * BACKFILL mode — drain all un-anchored real proofs in batches. Logs a
   * tx-count / cost ESTIMATE up front (it does not send here without a key; the
   * estimate is what Sean sees before flipping the key on). Bounded by maxBatches.
   */
  async backfill(opts: { maxBatches?: number } = {}): Promise<{
    batchesRun: number; proofsAnchored: number; stoppedReason: string;
  }> {
    const maxBatches = opts.maxBatches ?? Number.MAX_SAFE_INTEGER;

    // Cost/tx-count estimate BEFORE any send (task requirement). One EAS attest
    // tx per batch. This log fires regardless of key presence.
    const pending = await this.unanchoredCount();
    const estBatches = Math.ceil(pending / this.batchSize);
    console.log(
      `[eas-anchor][BACKFILL] estimate: ${pending} un-anchored real proofs → ` +
        `${estBatches} EAS attestation tx(s) at batchSize=${this.batchSize} ` +
        `(1 on-chain attest per batch on Base Sepolia). No send occurs without the attester key.`,
    );

    if (!this.eas.hasAttesterKey()) {
      markDegraded(
        { mode: 'backfill' },
        `attester key missing — backfill is a no-op; estimate only (${estBatches} tx would be needed)`,
        'eas-anchor',
      );
      return { batchesRun: 0, proofsAnchored: 0, stoppedReason: 'no attester key (degraded no-op)' };
    }

    let batchesRun = 0;
    let proofsAnchored = 0;
    while (batchesRun < maxBatches) {
      const r = await this.runBatch();
      if (r.status === 'no_work') return { batchesRun, proofsAnchored, stoppedReason: 'drained' };
      if (r.status === 'degraded') return { batchesRun, proofsAnchored, stoppedReason: 'degraded mid-run' };
      if (r.status === 'deferred') {
        // A failed attest would loop forever on the same batch (writeback did not
        // clear it). Stop and surface so Sean/ops can inspect rather than spin.
        return { batchesRun, proofsAnchored, stoppedReason: `deferred: ${r.reason ?? 'attest failed'}` };
      }
      batchesRun++;
      proofsAnchored += r.rowsWrittenBack;
    }
    return { batchesRun, proofsAnchored, stoppedReason: `maxBatches (${maxBatches}) reached` };
  }

  /** SCHEDULED mode — poll every intervalMs for new un-anchored real proofs. */
  start(intervalMs: number): void {
    if (process.env.EAS_ANCHOR_WORKER_ENABLED !== 'true') {
      console.log(
        '[eas-anchor] disabled — set EAS_ANCHOR_WORKER_ENABLED=true (and provide the attester key) to anchor real proofs.',
      );
      return;
    }
    if (!this.eas.hasAttesterKey()) {
      markDegraded(
        { worker: 'eas-anchor' },
        'EAS_ANCHOR_WORKER_ENABLED=true but attester key missing — worker not started (would no-op every tick)',
        'eas-anchor',
      );
      return;
    }
    console.log(`[eas-anchor] starting scheduled anchoring (interval=${intervalMs}ms, batchSize=${this.batchSize})`);
    // Initial tick, then on the interval. Both catch-guarded (RULE-8 spirit).
    this.tickGuarded();
    this.timer = setInterval(() => this.tickGuarded(), intervalMs);
  }

  private tickGuarded(): void {
    if (this.running) return; // no overlapping ticks
    this.running = true;
    void this.runBatch()
      .then((r) => {
        if (r.status === 'anchored') {
          console.log(`[eas-anchor] tick anchored ${r.rowsWrittenBack} proof(s) (batch ${r.batchCount}).`);
        }
      })
      .catch((e) => console.error('[eas-anchor] tick error:', e?.message ?? e, e?.stack))
      .finally(() => {
        this.running = false;
      });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const easAnchorWorker = new EasAnchorWorker();
