/**
 * immune/lane-a-dryrun.ts — stand up ONE real-economic E2E as an INERT dry-run thread (Lane A, D-145).
 *
 * Threads the pieces that already exist, writing NOTHING and moving no money / RepID / on-chain state:
 *
 *   precommit   work-statement-spec -> work_statement_hash          // the contract, hashed BEFORE the work
 *   acceptance  parseCriterionRatings -> satisfaction_score          // MULTI-criterion
 *   collapse    satisfaction >= threshold -> correct|incorrect       // VERSIONED, default-OFF, reversible knob
 *   receipt     runTrustedSettlement (dry-run)                       // signed + independently verified
 *   credit      buildImmuneExperimentalRow (would-write, shadow)     // the repid_experimental_events row it WOULD write
 *
 * WHY A HARNESS AND NOT NEW PRIMITIVES. Each leg above already exists and is tested; nothing here is forked.
 * What was missing is the THREAD: no production caller joins the precommit world (multi-criterion acceptance,
 * work_statement_hash on service_contracts) to the immune-receipt world (single binary verdict, experiment_id).
 * This file is that thread, inert, so the end-to-end shape is demonstrable and testable before any live wiring.
 *
 * THE JOIN, kept deliberately small (Claude+Grok concur, D-145):
 *  - The receipt is bound to the contract via `experiment_id = contractId` — a TRANSITIVE bind to the immutable
 *    work_statement_hash on service_contracts. This file does NOT add a field to, or otherwise change, the signed
 *    public combined receipt. Promoting work_statement_hash to a first-class bound receipt field is a public-receipt
 *    change and is Sean's MAJOR gate, not done here.
 *  - The multi-criterion satisfaction score is collapsed to the receipt's binary verdict by ONE versioned, reversible
 *    threshold (LANE_A_ACCEPTANCE_VERSION / LANE_A_ACCEPT_THRESHOLD, default 1.0 = every criterion met). The collapse
 *    is explicit on the output, never silent.
 *
 * HONESTY (hard rules):
 *  - SAME-CONTROLLER throughout. eligibility can only ever be same_controller_measured here; this is NOT
 *    independent-counterparty commerce and must never be described as such.
 *  - The demo receipt is authoritative:false — a DEMONSTRATION, not a trust anchor. settleImmuneReceipt's P0 gate
 *    correctly refuses it (status 'not_authoritative'); the would-write row is computed separately, honestly labelled.
 *  - Keys are caller PARAMETERS (throwaway Ed25519), never env secrets (D-129).
 *  - Default is dry-run; nothing is written, nothing is authoritative, no canonical RepID moves.
 *
 * OWNER (MAJOR) GATES, all left undone: an authoritative receipt (engine authenticates origin), the
 * EXPERIMENTAL_REPID_MODE + IMMUNE_SETTLE_ENABLED flags to move even shadow credit, the real testnet USDC
 * payment (x402) + ERC-8004 / EAS writes, a first-class work_statement_hash receipt field, and any canonical credit.
 */
import { createHash } from 'node:crypto';
import {
  parseWorkStatement,
  parseCriterionRatings,
  specWorkStatementHash,
} from '../services/work-statement-spec';
import { EXPERIMENTAL_LABEL, type ExperimentalEventRow } from '../services/experimental-repid';
import {
  fixtureOracle,
  runTrustedSettlement,
  type SettlementKeys,
} from './trusted-settler';
import {
  buildImmuneExperimentalRow,
  settleImmuneReceipt,
  type ImmuneSettleResult,
} from './experimental-settlement';

export const LANE_A_ACCEPTANCE_VERSION = 'lane-a-accept-v1';

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The fraction of acceptance criteria that must be met for the deliverable to count 'correct'. Reversible knob; default 1.0 (all). */
export function acceptanceThreshold(raw: string | undefined = process.env['LANE_A_ACCEPT_THRESHOLD']): number {
  const t = (raw ?? '').trim();
  if (t === '') return 1; // Number('') is 0, which would accept anything — default to "all criteria met".
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

/** Collapse a multi-criterion satisfaction score (0..1) to the receipt's binary verdict. Explicit on the output. */
export function satisfactionToVerdict(score: number, threshold: number = acceptanceThreshold()): 'correct' | 'incorrect' {
  return score >= threshold ? 'correct' : 'incorrect';
}

export interface LaneADryRunInput {
  /** The precommit work statement: deliverable, acceptance_criteria[], agreed_price, deadline. */
  spec: unknown;
  /** The buyer's per-criterion ratings: [{ n, met }]. Must cover every numbered criterion. */
  ratings: unknown;
  /** The exchange/contract id. Becomes the receipt's experiment_id (transitive bind to work_statement_hash). */
  contractId: string;
  /** The maker agent, as a repid_agents uuid. */
  makerAgentId: string;
  /** The produced deliverable. DATA ONLY — hashed, never executed. */
  deliverableArtifact: string;
  /** Four throwaway Ed25519 signing authorities (parameters, never env). */
  keys: SettlementKeys;
  /** Fallbacks when the spec is a loose payload. */
  priceUsdcRaw?: number;
  deadline?: string | Date | null;
}

export type LaneADryRun =
  | { ok: false; stage: 'precommit' | 'acceptance' | 'receipt'; reasons: string[] }
  | {
      ok: true;
      /** EXPERIMENTAL / same-controller disclaimer. This is not independent commerce. */
      label: string;
      // precommit
      work_statement_hash: string;
      deliverable_sha256: string;
      // acceptance (multi-criterion) + its explicit collapse to the receipt's binary verdict
      satisfaction_score: number;
      acceptance_version: string;
      threshold: number;
      verified_correct: 'correct' | 'incorrect';
      // receipt (bound to the contract via experiment_id; NOT modified here)
      experiment_id: string;
      receipt_content_hash: string;
      receipt_verified: boolean;
      receipt_authoritative: boolean;
      /** What settleImmuneReceipt did with this demo receipt — expected 'not_authoritative' or 'off' (nothing written). */
      immune_dryrun_status: ImmuneSettleResult['status'];
      // the experimental shadow row this WOULD write once the owner gates open. Not written.
      would_write: ExperimentalEventRow | null;
      eligibility: 'same_controller_measured';
      owner_gates: string[];
    };

const OWNER_GATES = [
  'authoritative receipt — the engine must authenticate origin (IMMUNE_ENGINE_AUTHORITY); this dry-run is authoritative:false',
  'EXPERIMENTAL_REPID_MODE=shadow|active + IMMUNE_SETTLE_ENABLED=1 to move even shadow experimental credit',
  'real testnet USDC payment (x402) + ERC-8004 / EAS on-chain writes',
  'promote work_statement_hash to a first-class bound receipt field (public-receipt change)',
  'any CANONICAL RepID credit',
];

/**
 * Run the Lane A thread as a dry-run. Reads nothing from the DB, writes nothing, moves no money/RepID/chain.
 * Returns the full bound record (precommit -> acceptance -> receipt -> would-write experimental shadow row), or a
 * refusal naming the stage. eligibility is hardcoded same_controller_measured: this harness never claims independence.
 */
export async function runLaneADryRun(input: LaneADryRunInput): Promise<LaneADryRun> {
  // 1. PRECOMMIT — hash the contract spec.
  const spec = parseWorkStatement(input.spec, { priceUsdcRaw: input.priceUsdcRaw, deadline: input.deadline });
  if (!spec.ok) return { ok: false, stage: 'precommit', reasons: [spec.error, spec.message] };

  // 2. ACCEPTANCE — rate every criterion -> fractional satisfaction score.
  const rated = parseCriterionRatings(input.ratings, spec.canonical);
  if (!rated.ok) return { ok: false, stage: 'acceptance', reasons: [rated.error, rated.message] };

  // 3. COLLAPSE — multi-criterion -> binary verdict, by a versioned, reversible threshold. Explicit on output.
  const threshold = acceptanceThreshold();
  const verified_correct = satisfactionToVerdict(rated.score, threshold);

  // 4. RECEIPT — build + independently verify a combined trust receipt via the existing settler (dry-run, same-controller).
  //    The receipt binds experiment_id = contractId (transitive bind to the immutable work_statement_hash). The signed
  //    receipt is NOT modified; the deliverable hash is surfaced on the Lane A record separately.
  const deliverable_sha256 = '0x' + sha256Hex(input.deliverableArtifact);
  const verdict = JSON.stringify({ id: input.contractId, verdict: verified_correct === 'correct' ? 'TRUE' : 'FALSE' });
  const verdict_sha256 = '0x' + sha256Hex(verdict);
  const oracle = fixtureOracle(
    [{ id: input.contractId, claim: spec.canonical.deliverable.slice(0, 120), expected: 'TRUE' }],
    `lane-a:${input.contractId}`,
  );
  const settled = runTrustedSettlement({
    bundle: {
      verdict,
      verdict_sha256,
      sandbox_receipt: { mission_id: input.contractId, airlock_decision: 'promote', artifact_sha256: verdict_sha256, profile_checks: [{ name: 'lane-a-dryrun', passed: true }] },
    },
    oracle,
    keys: input.keys,
    context: {
      experiment_id: input.contractId,
      claim_id: input.contractId,
      maker_id: input.makerAgentId,
      maker_controller: 'same-controller',
      checker_id: 'lane-a-oracle',
      checker_controller: 'same-controller', // same controller: independence is never claimed here
    },
  });
  if (!settled.ok) return { ok: false, stage: 'receipt', reasons: settled.refused };

  // 5. CREDIT — prove the P0 gate refuses our (non-authoritative) demo receipt, AND compute the would-write row.
  //    settleImmuneReceipt with default deps writes nothing (mode off / not authoritative / no store).
  const immune = await settleImmuneReceipt(
    { receipt: settled.receipt, verification: settled.verification, agentId: input.makerAgentId },
    {},
  );
  const would_write = buildImmuneExperimentalRow(settled.receipt, input.makerAgentId, 'same_controller_measured', 'shadow', null);

  return {
    ok: true,
    label: `${EXPERIMENTAL_LABEL} Lane A dry-run: same-controller, nothing written.`,
    work_statement_hash: specWorkStatementHash(spec.canonical),
    deliverable_sha256,
    satisfaction_score: rated.score,
    acceptance_version: LANE_A_ACCEPTANCE_VERSION,
    threshold,
    verified_correct,
    experiment_id: input.contractId,
    receipt_content_hash: settled.receipt.content_hash,
    receipt_verified: settled.verification.ok,
    receipt_authoritative: settled.verification.authoritative,
    immune_dryrun_status: immune.status,
    would_write,
    eligibility: 'same_controller_measured',
    owner_gates: OWNER_GATES,
  };
}
