/**
 * zkp_audit — a sellable A2A service whose deliverable is a REAL, buyer-verifiable
 * Plonky3 STARK proof (threshold attestation over a THIRD-PARTY agent's RepID).
 *
 * =============================================================================
 * WHAT THIS IS, STATED WITHOUT MARKETING
 * =============================================================================
 * A buyer agent pays a provider agent to produce a cryptographic attestation
 * about a THIRD agent (the *subject*): "subject's RepID > threshold". The
 * artifact is produced by the live external `zkp-postcard` prover
 * (`plonky3_range_check`) and is independently checkable by the buyer, offline,
 * with `@hyperdag/proof-verifier` (WASM) — no call to any HyperDAG server.
 *
 * Two honesty limits are load-bearing and are echoed INTO the deliverable so a
 * buyer cannot be misled by a downstream sales surface:
 *
 *   (a) NOT SCORE PRIVACY. Today's circuit publishes the exact score in the
 *       public statement. This is a portable, non-repudiable THRESHOLD
 *       ATTESTATION. "Without revealing the exact score" would be a lie.
 *
 *   (b) TRUSTLESS ABOUT THE RELATION, TRUSTED ABOUT THE WITNESS SOURCE. The
 *       prover reads `current_repid` server-side from HyperDAG's own Supabase.
 *       The maths binds {agent_id, repid_score, threshold} into the transcript;
 *       it says nothing about whether that score was honestly earned.
 *
 * =============================================================================
 * THE STUB / REAL BOUNDARY — NEVER CROSSED HERE
 * =============================================================================
 * `src/zkp/plonky3-stub.ts` (sha256) and `src/zkp/plonky3-real.ts` (which falls
 * back to an HMAC-SHA256 stub whenever `PLONKY3_PROVER_URL` / `ZKP_SERVICE_URL`
 * is unset) are NOT proof systems. This module never imports either. The only
 * real proving in reach is an HTTP call to the external `zkp-postcard` service.
 * A missing prover URL, a non-2xx, or a timeout is a HARD FAILURE — we degrade
 * CLOSED, never to a fallback. "Degrade loudly" is not sufficient for a paid
 * cryptographic deliverable.
 *
 * =============================================================================
 * FAILURE SEMANTICS — deliberately NOT the dispute queue
 * =============================================================================
 * The adversarial review established that routing a self-verify failure to
 * `dispute_validation_queue` is actively harmful: `DisputeResolutionWorker`
 * runs an LLM panel over a base64 blob, and a `buyer_at_fault` ruling pays the
 * provider +20 and fines the innocent buyer −50. A provider whose proof does
 * not verify would be REWARDED. So every gate in this module THROWS.
 * `ServiceHandlerBase` catches, leaves the contract `escrowed` with a loud
 * error trail in metadata, applies NO `SERVICE_FULFILLED` deltas, opens NO
 * dispute, and writes no receipt. Nothing reaches the buyer.
 *
 * `verifyDeliverable()` is exported precisely so a dispute panel (or the buyer,
 * or a route guard) can re-run the deterministic check instead of asking an LLM
 * to read a proof. It is the same check the producer ran, run by someone else.
 *
 * =============================================================================
 * NO SELF-VALIDATION
 * =============================================================================
 * The self-verify step is producer==verifier ONLY in the direction that can
 * FAIL the producer. It never certifies quality to anyone: passing it is a
 * precondition for delivery, not an attestation of delivery. The authoritative
 * checks are the buyer's own local `verify()` and an independent re-run of
 * `verifyDeliverable()`. Separately, SUBJECT-DISJOINT forbids the subject from
 * being either counterparty.
 *
 * Schema note: everything read here was confirmed against the live database on
 * 2026-07-31 (repid_zkp_proofs has NO contract_id and NO proof_size_bytes
 * column; `is_real` is trigger-derived and CHECK-guarded by
 * `repid_zkp_proofs_is_real_integrity`). `zkp_audit_receipts` is a PROPOSED
 * additive table — see sqlProposed. This module never applies DDL.
 */
import { buildPostcardCommitment, generateNonce } from '../zkp/commitment';
import { buildBoundStatement } from '../zkp/proof-statement-guard';
import { hasTruthySimFlag } from '../utils/truthy';
import type { ServiceContractRow } from '../types';

/* ============================================================================
 * Constants
 * ==========================================================================*/

/**
 * On-wire service type. REUSE-BEFORE-CREATE: `agent_services.service_type` is
 * FK-bound to `service_categories(category_name)`, and that table already
 * carries `zkp_attestation` (created 2026-05-28, `v1_active=false`, description
 * verbatim this service). Minting a new `zkp_audit` category would be a
 * gratuitous duplicate. The file/class names stay `zkp-audit` per the build
 * spec; the marketplace name is `zkp_attestation`. This mismatch is deliberate
 * and is flagged as an open question, not an accident.
 */
export const ZKP_AUDIT_SERVICE_TYPE = 'zkp_attestation';

/** The prover's scheme must start with this. `sha256_commitment_poc` is refused. */
export const REQUIRED_SCHEME_PREFIX = 'plonky3';

/**
 * The four keys `@hyperdag/proof-verifier@0.2.0` hard-requires. Measured: with
 * `agent_id` omitted the WASM verifier returns
 * "input parse error: missing field `agent_id`"; with `tier` omitted, "missing
 * field `tier`". All 21,968 existing real rows in `repid_zkp_proofs` store only
 * `{threshold, repid_score}` and are therefore, as stored, unverifiable by the
 * tool we publish. This service always writes all four.
 */
export const REQUIRED_STATEMENT_KEYS = ['agent_id', 'tier', 'repid_score', 'threshold'] as const;

/** Canonical tier bands (CLAUDE.md). Score clamp is [10, 10000]. */
const TIER_BANDS: ReadonlyArray<{ max: number; tier: string }> = [
  { max: 499, tier: 'PROBATIONARY' },
  { max: 999, tier: 'EARNING' },
  { max: 4999, tier: 'ESTABLISHED' },
  { max: 7999, tier: 'AUTONOMOUS' },
  { max: Number.POSITIVE_INFINITY, tier: 'VETERAN' },
];

/** Contract statuses that count as a *completed* commercial interaction. */
const COMPLETED_CONTRACT_STATUSES = ['fulfilled', 'satisfied', 'settled', 'resolved'] as const;

/* ============================================================================
 * Errors — every one of these is a THROW, never a dispute
 * ==========================================================================*/

export type ZkpAuditFailureCode =
  | 'PAYLOAD_INVALID'
  | 'SUBJECT_NOT_DISJOINT'
  | 'SUBJECT_NOT_FOUND'
  | 'BUYER_NOT_FOUND'
  | 'PAYMENT_MISSING'
  | 'PAYMENT_SIMULATED'
  | 'ADMISSION_REFUSED'
  | 'PROVER_UNAVAILABLE'
  | 'PROVER_ERROR'
  | 'NOT_A_REAL_PROOF'
  | 'STATEMENT_INCOMPLETE'
  | 'SUBJECT_MISMATCH'
  | 'SELF_VERIFY_FAILED'
  | 'PERSIST_FAILED';

export class ZkpAuditError extends Error {
  public readonly code: ZkpAuditFailureCode;
  public readonly detail: Record<string, unknown>;

  constructor(code: ZkpAuditFailureCode, message: string, detail: Record<string, unknown> = {}) {
    super(`zkp_audit[${code}]: ${message}`);
    this.name = 'ZkpAuditError';
    this.code = code;
    this.detail = detail;
  }
}

/* ============================================================================
 * Injectable dependency surface (no ambient singletons — the tests drive real
 * code paths with scripted doubles rather than mocking module internals)
 * ==========================================================================*/

/** Minimal shape of a supabase-js query result. */
export interface DbResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/** Minimal structural view of the supabase client this module uses. */
export interface DbLike {
  from(table: string): any;
}

/** `@hyperdag/proof-verifier@0.2.0` verify() result shape. */
export interface VerifyResult {
  verified: boolean;
  error: string | null;
  proof_size_bytes: number;
  verifier_version: string;
}

export type VerifyFn = (
  proofBytes: string,
  statement: Record<string, unknown>
) => Promise<VerifyResult>;

/**
 * Cost-based admission policy.
 *
 * WHY THIS EXISTS: the identity-based anti-self-dealing model
 * (`buyer_agent_id <> provider_agent_id`) is worth exactly one free
 * `POST /api/v1/agents/register` to an attacker. An operator with three sybils
 * — buyer, provider, subject — satisfies every UUID-inequality check while
 * paying itself, and every such round trip mints a genuine Plonky3 artifact
 * over a farmed score. UUID inequality cannot be the only gate on a rail whose
 * output is a durable cryptographic certificate.
 *
 * These are the checks this component CAN enforce from inside `fulfill()`. They
 * raise the cost; they do not eliminate the attack. The route-level fixes
 * (registration cost, per-pair delta caps in the scoring pipeline) are outside
 * the three files this component may create and are reported as wiring.
 */
export interface AdmissionPolicy {
  /** Buyer must hold at least this RepID. Mirrors the 500 `min_repid_to_purchase` default. */
  minBuyerRepid: number;
  /** Subject must hold at least this RepID (a fresh sybil starts far below a real agent). */
  minSubjectRepid: number;
  /**
   * Subject must have completed contracts with at least this many DISTINCT
   * counterparties that are NEITHER the buyer NOR the provider. A three-sybil
   * ring cannot satisfy this without recruiting an outside agent.
   */
  minSubjectIndependentCounterparties: number;
  /** Max receipts for one (buyer, provider) pair in a rolling 24h window. */
  maxPairReceiptsPerDay: number;
  /** Reject a subject account younger than this (ms). Sybils are new. */
  minSubjectAccountAgeMs: number;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  minBuyerRepid: 500,
  minSubjectRepid: 500,
  minSubjectIndependentCounterparties: 1,
  maxPairReceiptsPerDay: 3,
  minSubjectAccountAgeMs: 7 * 24 * 60 * 60 * 1000,
};

export interface ZkpAuditDeps {
  db: DbLike;
  /**
   * Base URL of the external `zkp-postcard` prover. `null`/empty is a HARD
   * FAILURE (PROVER_UNAVAILABLE), never a fallback to the in-repo HMAC stub.
   */
  proverUrl: string | null;
  fetchImpl?: typeof fetch;
  /** WASM verifier. The handler injects the real `@hyperdag/proof-verifier`. */
  verifyImpl: VerifyFn;
  now?: () => Date;
  proverTimeoutMs?: number;
  admission?: Partial<AdmissionPolicy>;
  log?: (msg: string) => void;
  warn?: (msg: string, ...rest: unknown[]) => void;
}

/* ============================================================================
 * Payload + deliverable shapes
 * ==========================================================================*/

export interface ZkpAuditPayload {
  /** The THIRD agent being attested about. Named by the BUYER, never the provider. */
  subject_agent_id: string;
  /**
   * Optional. The prover chooses the threshold it actually proves (open
   * question: whether it honours a caller-supplied one). This is echoed back
   * with `requested_threshold_honored`, computed by COMPARISON — never by
   * re-verifying at a different threshold.
   */
  requested_threshold?: number;
  purpose?: string;
}

export interface ZkpAuditDeliverable extends Record<string, unknown> {
  verdict: 'PASS';
  service_type: string;
  contract_id: string;
  subject_agent_id: string;
  /** The COMPLETE public statement — exactly the four keys the verifier parses. */
  statement: Record<string, unknown>;
  proof_bytes: string;
  proof_sha256: string;
  proof_size_bytes: number;
  scheme: string;
  zkp_proof_id: number;
  zk_commitment: string;
  verifier_pkg: '@hyperdag/proof-verifier';
  verifier_version: string;
  self_verify_ok: true;
  tier_derived: string;
  proven_threshold: number;
  requested_threshold: number | null;
  requested_threshold_honored: boolean | null;
  score_source: string;
  produced_at: string;
  /** Written in plain words so no downstream surface can quietly overclaim. */
  honesty: {
    score_is_public: true;
    is_score_privacy: false;
    statement_tier_is_unauthenticated: true;
    witness_source: string;
    contract_id_bound_in_stark: false;
    freshness_attested_by: string;
  };
  patent_marker: 'P-001';
}

/* ============================================================================
 * Pure helpers — independently testable, no I/O
 * ==========================================================================*/

/**
 * Canonical tier from a RepID score. DERIVED, never copied from
 * `statement.tier`: measured, substituting `tier: 'VETERAN'` into an
 * ESTABLISHED proof's statement still verifies, so the tier field carries no
 * cryptographic authority whatsoever.
 */
export function deriveTier(score: number): string {
  const s = Math.max(10, Math.min(10000, Math.round(score)));
  for (const band of TIER_BANDS) {
    if (s <= band.max) return band.tier;
  }
  return 'VETERAN';
}

/**
 * SUBJECT-DISJOINT. Layered on the live DB CHECK
 * `service_contracts_no_self_dealing` (buyer <> provider) — this adds the
 * subject leg, which no existing constraint covers.
 */
export function assertSubjectDisjoint(args: {
  subjectAgentId: string;
  buyerAgentId: string;
  providerAgentId: string;
}): void {
  if (args.subjectAgentId === args.buyerAgentId) {
    throw new ZkpAuditError(
      'SUBJECT_NOT_DISJOINT',
      'subject_agent_id equals buyer_agent_id — an agent may not buy an audit of itself',
      { subject: args.subjectAgentId }
    );
  }
  if (args.subjectAgentId === args.providerAgentId) {
    throw new ZkpAuditError(
      'SUBJECT_NOT_DISJOINT',
      'subject_agent_id equals provider_agent_id — an auditor may not audit itself',
      { subject: args.subjectAgentId }
    );
  }
}

/** Parse and validate the buyer-supplied payload. */
export function parseZkpAuditPayload(raw: unknown): ZkpAuditPayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  const subject = p.subject_agent_id;
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    throw new ZkpAuditError(
      'PAYLOAD_INVALID',
      'payload.subject_agent_id (non-empty string) is required'
    );
  }
  let requested: number | undefined;
  if (p.requested_threshold !== undefined && p.requested_threshold !== null) {
    const n = Number(p.requested_threshold);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new ZkpAuditError(
        'PAYLOAD_INVALID',
        'payload.requested_threshold must be a non-negative integer when present',
        { requested_threshold: p.requested_threshold }
      );
    }
    requested = n;
  }
  const out: ZkpAuditPayload = { subject_agent_id: subject.trim() };
  if (requested !== undefined) out.requested_threshold = requested;
  if (typeof p.purpose === 'string' && p.purpose.length > 0) out.purpose = p.purpose;
  return out;
}

/**
 * Extract the threshold the prover ACTUALLY proved, from its
 * `public_statement` ("RepID > N"). Measured on the live verifier: changing a
 * proven threshold 999 -> 500 breaks the transcript
 * (`InvalidOpeningArgument(InvalidPowWitness)`), and 999 -> 1000 (== score)
 * fails with "Statement claim (score <= threshold) is invalid" — so the proven
 * relation is strict `score > threshold`. We never re-label it.
 */
export function parseProvenThreshold(publicStatement: unknown): number | null {
  if (typeof publicStatement !== 'string') return null;
  const m = publicStatement.match(/(\d+)/);
  const captured = m ? m[1] : undefined;
  if (captured === undefined) return null;
  const n = Number(captured);
  return Number.isFinite(n) ? n : null;
}

/**
 * Assemble the COMPLETE public statement. Exactly four keys, nothing more —
 * the WASM verifier parses this with a fixed struct, so extra keys are a
 * needless deserialisation risk.
 */
export function buildCompleteStatement(args: {
  subjectAgentId: string;
  repidScore: number;
  threshold: number;
}): Record<string, unknown> {
  // Delegated to the shared fail-closed guard (2026-08-09 corpus hygiene): an empty
  // subject id now THROWS instead of producing an agent-less statement, closing the
  // same gap that let 7,958 unbound rows into repid_zkp_proofs. The guard derives the
  // tier from the score with identical bands to deriveTier() above, so the returned
  // statement is byte-identical for every non-empty subject.
  return buildBoundStatement({
    agentId: args.subjectAgentId,
    repidScore: args.repidScore,
    threshold: args.threshold,
  });
}

/** STATEMENT-COMPLETE predicate. */
export function statementIsComplete(statement: unknown): statement is Record<string, unknown> {
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return false;
  const s = statement as Record<string, unknown>;
  return REQUIRED_STATEMENT_KEYS.every(
    (k) => Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined && s[k] !== null
  );
}

/** REAL-PROOF-ONLY predicate. */
export function isRealPlonky3(scheme: unknown, proofBytes: unknown): boolean {
  return (
    typeof scheme === 'string' &&
    scheme.toLowerCase().startsWith(REQUIRED_SCHEME_PREFIX) &&
    scheme !== 'sha256-stub' &&
    typeof proofBytes === 'string' &&
    proofBytes.length > 0
  );
}

/** sha256 of the base64 proof string, for receipt-level tamper evidence. */
export function proofDigest(proofBytesB64: string): string {
  // Local require keeps this module importable in any runtime that has crypto.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  return '0x' + createHash('sha256').update(proofBytesB64).digest('hex');
}

/* ============================================================================
 * Independent re-verification — the dispute-panel / buyer entry point
 * ==========================================================================*/

export interface DeliverableVerification {
  ok: boolean;
  /** Machine-readable reasons, empty iff ok. */
  failures: string[];
  verified: boolean | null;
  verifier_version: string | null;
  verifier_error: string | null;
}

/**
 * Deterministically re-check a stored `service_contracts.result` produced by
 * this service. Takes ~110ms and yields the same answer for everyone, which is
 * what makes a dispute over this artifact uniquely cheap to adjudicate.
 *
 * This is what `DisputeResolutionWorker` should call BEFORE any LLM panel. It
 * is deliberately exported and dependency-injected so the caller is never the
 * producer.
 */
export async function verifyDeliverable(
  result: unknown,
  deps: { verifyImpl: VerifyFn; expectedSubjectAgentId?: string }
): Promise<DeliverableVerification> {
  const failures: string[] = [];
  const r = (result ?? {}) as Record<string, unknown>;

  const statement = r.statement;
  const proofBytes = r.proof_bytes;
  const scheme = r.scheme;

  if (!statementIsComplete(statement)) {
    failures.push('STATEMENT_INCOMPLETE');
  }
  if (!isRealPlonky3(scheme, proofBytes)) {
    failures.push('NOT_A_REAL_PROOF');
  }
  if (
    deps.expectedSubjectAgentId !== undefined &&
    statementIsComplete(statement) &&
    statement.agent_id !== deps.expectedSubjectAgentId
  ) {
    failures.push('SUBJECT_MISMATCH');
  }
  if (
    typeof r.proof_sha256 === 'string' &&
    typeof proofBytes === 'string' &&
    proofDigest(proofBytes) !== r.proof_sha256
  ) {
    failures.push('PROOF_DIGEST_MISMATCH');
  }

  if (failures.length > 0) {
    return { ok: false, failures, verified: null, verifier_version: null, verifier_error: null };
  }

  try {
    const v = await deps.verifyImpl(
      proofBytes as string,
      statement as Record<string, unknown>
    );
    if (v.verified !== true) {
      return {
        ok: false,
        failures: ['WASM_VERIFY_FAILED'],
        verified: false,
        verifier_version: v.verifier_version ?? null,
        verifier_error: v.error ?? null,
      };
    }
    return {
      ok: true,
      failures: [],
      verified: true,
      verifier_version: v.verifier_version ?? null,
      verifier_error: null,
    };
  } catch (e: unknown) {
    return {
      ok: false,
      failures: ['WASM_VERIFY_THREW'],
      verified: null,
      verifier_version: null,
      verifier_error: e instanceof Error ? e.message : String(e),
    };
  }
}

/* ============================================================================
 * The service
 * ==========================================================================*/

export interface ZkpAuditService {
  /** Full produce-or-throw cycle. Returns only fully-verified deliverables. */
  produceAudit(contract: ServiceContractRow): Promise<ZkpAuditDeliverable>;
}

interface SubjectRow {
  id: string;
  agent_name: string | null;
  current_repid: number | null;
  tier: string | null;
  created_at: string | null;
  lifecycle_status: string | null;
}

export function createZkpAuditService(deps: ZkpAuditDeps): ZkpAuditService {
  const httpFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const proverTimeoutMs = deps.proverTimeoutMs ?? 30000;
  const policy: AdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, ...(deps.admission ?? {}) };
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string, ...rest: unknown[]) => console.warn(m, ...rest));

  /* ---------------------------- money is real --------------------------- */

  async function assertRealMoney(contract: ServiceContractRow): Promise<string> {
    const paymentId = (contract as unknown as Record<string, unknown>).x402_payment_id;
    if (typeof paymentId !== 'string' || paymentId.length === 0) {
      throw new ZkpAuditError(
        'PAYMENT_MISSING',
        'contract has no x402_payment_id — a paid cryptographic deliverable is not produced for free',
        { contract_id: contract.id }
      );
    }
    if (hasTruthySimFlag(contract.metadata) || hasTruthySimFlag(contract.payload)) {
      throw new ZkpAuditError('PAYMENT_SIMULATED', 'contract carries a simulation flag', {
        contract_id: contract.id,
      });
    }
    const { data, error }: DbResult<{ is_simulated: boolean }> = await deps.db
      .from('x402_settlements')
      .select('is_simulated')
      .eq('id', paymentId)
      .maybeSingle();
    if (error) {
      throw new ZkpAuditError('PAYMENT_MISSING', `x402_settlements lookup failed: ${error.message}`, {
        x402_payment_id: paymentId,
      });
    }
    if (!data) {
      throw new ZkpAuditError('PAYMENT_MISSING', 'x402_settlements row not found', {
        x402_payment_id: paymentId,
      });
    }
    if (data.is_simulated === true) {
      throw new ZkpAuditError(
        'PAYMENT_SIMULATED',
        'settlement is_simulated=true — refusing to mint a real proof against fake money',
        { x402_payment_id: paymentId }
      );
    }
    return paymentId;
  }

  /* ------------------------- cost-based admission ----------------------- */

  async function fetchAgent(agentId: string): Promise<SubjectRow | null> {
    const { data, error }: DbResult<SubjectRow> = await deps.db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier, created_at, lifecycle_status')
      .eq('id', agentId)
      .maybeSingle();
    if (error) {
      throw new ZkpAuditError('SUBJECT_NOT_FOUND', `repid_agents lookup failed: ${error.message}`, {
        agent_id: agentId,
      });
    }
    return data;
  }

  async function assertAdmissible(args: {
    subject: SubjectRow;
    buyerAgentId: string;
    providerAgentId: string;
  }): Promise<void> {
    const { subject, buyerAgentId, providerAgentId } = args;

    const buyer = await fetchAgent(buyerAgentId);
    if (!buyer) {
      throw new ZkpAuditError('BUYER_NOT_FOUND', 'buyer agent row not found', {
        buyer_agent_id: buyerAgentId,
      });
    }

    if ((buyer.current_repid ?? 0) < policy.minBuyerRepid) {
      throw new ZkpAuditError(
        'ADMISSION_REFUSED',
        `buyer RepID ${buyer.current_repid ?? 0} below minimum ${policy.minBuyerRepid}`,
        { check: 'minBuyerRepid' }
      );
    }
    if ((subject.current_repid ?? 0) < policy.minSubjectRepid) {
      throw new ZkpAuditError(
        'ADMISSION_REFUSED',
        `subject RepID ${subject.current_repid ?? 0} below minimum ${policy.minSubjectRepid}`,
        { check: 'minSubjectRepid' }
      );
    }
    if (subject.lifecycle_status && subject.lifecycle_status !== 'active') {
      throw new ZkpAuditError(
        'ADMISSION_REFUSED',
        `subject lifecycle_status='${subject.lifecycle_status}' is not active`,
        { check: 'lifecycleStatus' }
      );
    }
    if (subject.created_at) {
      const ageMs = now().getTime() - new Date(subject.created_at).getTime();
      if (Number.isFinite(ageMs) && ageMs < policy.minSubjectAccountAgeMs) {
        throw new ZkpAuditError(
          'ADMISSION_REFUSED',
          `subject account age ${Math.round(ageMs / 3600000)}h below minimum ${Math.round(
            policy.minSubjectAccountAgeMs / 3600000
          )}h`,
          { check: 'minSubjectAccountAgeMs' }
        );
      }
    }

    // Independent counterparty history. A three-sybil ring (buyer, provider,
    // subject) cannot satisfy this without recruiting an outside agent, which
    // is the point: the cost is no longer one free registration.
    const { data: rows, error: histErr }: DbResult<
      Array<{ buyer_agent_id: string; provider_agent_id: string }>
    > = await deps.db
      .from('service_contracts')
      .select('buyer_agent_id, provider_agent_id')
      .or(`buyer_agent_id.eq.${subject.id},provider_agent_id.eq.${subject.id}`)
      .in('status', COMPLETED_CONTRACT_STATUSES as unknown as string[])
      .limit(500);
    if (histErr) {
      throw new ZkpAuditError(
        'ADMISSION_REFUSED',
        `subject history lookup failed: ${histErr.message}`,
        { check: 'independentCounterparties' }
      );
    }
    const independent = new Set<string>();
    for (const row of rows ?? []) {
      const other = row.buyer_agent_id === subject.id ? row.provider_agent_id : row.buyer_agent_id;
      if (other && other !== subject.id && other !== buyerAgentId && other !== providerAgentId) {
        independent.add(other);
      }
    }
    if (independent.size < policy.minSubjectIndependentCounterparties) {
      throw new ZkpAuditError(
        'ADMISSION_REFUSED',
        `subject has ${independent.size} independent counterparties, needs ${policy.minSubjectIndependentCounterparties}`,
        { check: 'independentCounterparties' }
      );
    }

    // Per-pair rate cap — bounds how fast one (buyer, provider) pair can mint
    // certificates even when every other gate is satisfied.
    const since = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent, error: capErr }: DbResult<Array<{ id: number }>> = await deps.db
      .from('zkp_audit_receipts')
      .select('id')
      .eq('buyer_agent_id', buyerAgentId)
      .eq('provider_agent_id', providerAgentId)
      .gte('created_at', since)
      .limit(policy.maxPairReceiptsPerDay + 1);
    if (capErr) {
      throw new ZkpAuditError(
        'ADMISSION_REFUSED',
        `pair rate-cap lookup failed: ${capErr.message}`,
        { check: 'maxPairReceiptsPerDay' }
      );
    }
    if ((recent?.length ?? 0) >= policy.maxPairReceiptsPerDay) {
      throw new ZkpAuditError(
        'ADMISSION_REFUSED',
        `(buyer, provider) pair already has ${recent?.length ?? 0} receipts in 24h; cap is ${policy.maxPairReceiptsPerDay}`,
        { check: 'maxPairReceiptsPerDay' }
      );
    }
  }

  /* ------------------------------ idempotency --------------------------- */

  async function loadExistingReceipt(contractId: string): Promise<ZkpAuditDeliverable | null> {
    const { data, error }: DbResult<Record<string, unknown>> = await deps.db
      .from('zkp_audit_receipts')
      .select('*')
      .eq('contract_id', contractId)
      .maybeSingle();
    if (error) {
      // A receipts-table read failure must not silently mint a SECOND proof for
      // a contract that already has one. Fail closed.
      throw new ZkpAuditError(
        'PERSIST_FAILED',
        `zkp_audit_receipts lookup failed: ${error.message}`,
        { contract_id: contractId }
      );
    }
    if (!data) return null;

    const proofId = Number(data.zkp_proof_id);
    const { data: proofRow, error: proofErr }: DbResult<{
      proof_bytes: string | null;
      scheme: string | null;
      zk_commitment: string | null;
    }> = await deps.db
      .from('repid_zkp_proofs')
      .select('proof_bytes, scheme, zk_commitment')
      .eq('id', proofId)
      .maybeSingle();
    if (proofErr || !proofRow || !proofRow.proof_bytes || !proofRow.scheme) {
      throw new ZkpAuditError(
        'PERSIST_FAILED',
        'receipt exists but its repid_zkp_proofs row is missing or incomplete',
        { contract_id: contractId, zkp_proof_id: proofId }
      );
    }

    const statement = (data.statement ?? {}) as Record<string, unknown>;
    const thresholdRaw = statement.threshold;
    return {
      verdict: 'PASS',
      service_type: ZKP_AUDIT_SERVICE_TYPE,
      contract_id: contractId,
      subject_agent_id: String(data.subject_agent_id),
      statement,
      proof_bytes: proofRow.proof_bytes,
      proof_sha256: String(data.proof_sha256),
      proof_size_bytes: Number(data.proof_size_bytes),
      scheme: proofRow.scheme,
      zkp_proof_id: proofId,
      zk_commitment: proofRow.zk_commitment ?? '',
      verifier_pkg: '@hyperdag/proof-verifier',
      verifier_version: String(data.verifier_version),
      self_verify_ok: true,
      tier_derived: String(data.tier_derived),
      proven_threshold: Number(thresholdRaw),
      requested_threshold: null,
      requested_threshold_honored: null,
      score_source: 'server_side_lookup',
      produced_at: String(data.created_at),
      honesty: HONESTY_BLOCK,
      patent_marker: 'P-001',
    };
  }

  /* -------------------------------- prover ------------------------------ */

  interface ProverResponse {
    proof_type?: string;
    proof_bytes?: string;
    proof_size_bytes?: number;
    commitment?: string;
    public_statement?: string;
    repid_score_actual?: number;
    score_source?: string;
    tier?: string;
  }

  async function callProver(args: {
    subjectAgentId: string;
    score: number;
    nonce: string;
    requestedThreshold?: number;
    contractId: string;
    purpose?: string;
  }): Promise<ProverResponse> {
    const base = (deps.proverUrl ?? '').trim();
    if (base.length === 0) {
      // DEGRADE CLOSED. The in-repo `plonky3-real.ts` would silently return an
      // HMAC here; that path is exactly what a fraudulent provider wants.
      throw new ZkpAuditError(
        'PROVER_UNAVAILABLE',
        'no prover URL configured (ZKP_SERVICE_URL) — refusing to fall back to the in-repo HMAC/sha256 stub'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), proverTimeoutMs);
    try {
      const body: Record<string, unknown> = {
        agent_id: args.subjectAgentId,
        score: args.score,
        nonce: args.nonce,
        metadata: {
          contract_id: args.contractId,
          service_type: ZKP_AUDIT_SERVICE_TYPE,
          ...(args.purpose ? { purpose: args.purpose } : {}),
        },
      };
      // Sent opportunistically. OPEN QUESTION: it is not established that the
      // prover honours a caller-supplied threshold (stored rows suggest it
      // picks the subject's TIER FLOOR). We never assume it did — the proven
      // threshold is always read back out of the prover's own public_statement.
      if (args.requestedThreshold !== undefined) body.threshold = args.requestedThreshold;

      const res = await httpFetch(`${base.replace(/\/+$/, '')}/zkp/repid-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ZkpAuditError('PROVER_ERROR', `prover HTTP ${res.status}: ${text.slice(0, 400)}`, {
          status: res.status,
        });
      }
      return (await res.json()) as ProverResponse;
    } catch (e: unknown) {
      if (e instanceof ZkpAuditError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ZkpAuditError('PROVER_ERROR', `prover timeout after ${proverTimeoutMs}ms`);
      }
      throw new ZkpAuditError(
        'PROVER_ERROR',
        `prover call failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------- the cycle ---------------------------- */

  async function produceAudit(contract: ServiceContractRow): Promise<ZkpAuditDeliverable> {
    const payload = parseZkpAuditPayload(contract.payload);

    assertSubjectDisjoint({
      subjectAgentId: payload.subject_agent_id,
      buyerAgentId: contract.buyer_agent_id,
      providerAgentId: contract.provider_agent_id,
    });

    // IDEMPOTENT: a retried fulfil reuses the proof it already paid for.
    const existing = await loadExistingReceipt(contract.id);
    if (existing) {
      log(`[zkp_audit] contract ${contract.id} already has receipt — returning existing proof`);
      return existing;
    }

    const x402SettlementId = await assertRealMoney(contract);

    const subject = await fetchAgent(payload.subject_agent_id);
    if (!subject) {
      throw new ZkpAuditError('SUBJECT_NOT_FOUND', 'subject agent not found', {
        subject_agent_id: payload.subject_agent_id,
      });
    }

    await assertAdmissible({
      subject,
      buyerAgentId: contract.buyer_agent_id,
      providerAgentId: contract.provider_agent_id,
    });

    const dbScore = subject.current_repid ?? 0;

    // Contract-bound nonce. The STARK transcript binds {agent_id, repid_score,
    // threshold} and NOTHING ELSE — it cannot bind contract_id without a
    // circuit change. Folding contract_id into the per-proof nonce binds the
    // contract into the STORED commitment, which is a HyperDAG-level binding,
    // not a mathematical one. Said plainly in the deliverable's honesty block.
    const nonce = contractBoundNonce(contract.id);

    const prover = await callProver({
      subjectAgentId: subject.id,
      score: dbScore,
      nonce,
      ...(payload.requested_threshold !== undefined
        ? { requestedThreshold: payload.requested_threshold }
        : {}),
      contractId: contract.id,
      ...(payload.purpose !== undefined ? { purpose: payload.purpose } : {}),
    });

    const scheme = prover.proof_type;
    const proofBytes = prover.proof_bytes;
    if (!isRealPlonky3(scheme, proofBytes)) {
      throw new ZkpAuditError(
        'NOT_A_REAL_PROOF',
        `prover returned scheme='${String(scheme)}' with ${
          typeof proofBytes === 'string' ? proofBytes.length : 0
        } bytes — only a real plonky3* proof is sellable`,
        { scheme }
      );
    }
    const realScheme = scheme as string;
    const realProofBytes = proofBytes as string;

    const provenThreshold = parseProvenThreshold(prover.public_statement);
    if (provenThreshold === null) {
      throw new ZkpAuditError(
        'STATEMENT_INCOMPLETE',
        'prover did not return a parseable public_statement — the proven threshold is unknown, so no complete statement can be assembled',
        { public_statement: prover.public_statement ?? null }
      );
    }

    // Prefer the prover's server-side score. Falling back to our own DB read is
    // safe ONLY because the self-verify below is the backstop: a mismatch
    // between the assembled statement and the transcript fails verification and
    // this whole call throws rather than shipping a wrong statement.
    const provenScore =
      typeof prover.repid_score_actual === 'number' ? prover.repid_score_actual : dbScore;
    const scoreSource =
      typeof prover.score_source === 'string'
        ? prover.score_source
        : typeof prover.repid_score_actual === 'number'
          ? 'prover_server_side_lookup'
          : 'engine_db_read_fallback';

    const statement = buildCompleteStatement({
      subjectAgentId: subject.id,
      repidScore: provenScore,
      threshold: provenThreshold,
    });
    if (!statementIsComplete(statement)) {
      throw new ZkpAuditError('STATEMENT_INCOMPLETE', 'assembled statement is missing required keys');
    }
    if (statement.agent_id !== payload.subject_agent_id) {
      throw new ZkpAuditError(
        'SUBJECT_MISMATCH',
        'proof statement agent_id does not match the subject the buyer named',
        { expected: payload.subject_agent_id, got: statement.agent_id }
      );
    }

    // SELF-VERIFY-OR-FAIL. A fail-closed gate, NOT an attestation.
    let verification: VerifyResult;
    try {
      verification = await deps.verifyImpl(realProofBytes, statement);
    } catch (e: unknown) {
      throw new ZkpAuditError(
        'SELF_VERIFY_FAILED',
        `WASM verifier threw: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (verification.verified !== true) {
      throw new ZkpAuditError(
        'SELF_VERIFY_FAILED',
        `proof did not verify against its own statement: ${verification.error ?? 'unknown'}`,
        { verifier_version: verification.verifier_version }
      );
    }

    const proofSizeBytes =
      typeof verification.proof_size_bytes === 'number' && verification.proof_size_bytes > 0
        ? verification.proof_size_bytes
        : typeof prover.proof_size_bytes === 'number'
          ? prover.proof_size_bytes
          : Math.ceil((realProofBytes.length * 3) / 4);

    const tierDerived = deriveTier(provenScore);
    const zkCommitment = buildPostcardCommitment({
      agentId: subject.id,
      score: provenScore,
      // Authoritative tier for the commitment preimage is the DB's
      // (trg_sync_tier owns it); the derived one is what we PUBLISH.
      tier: subject.tier ?? tierDerived,
      nonce,
      proverCommitment: prover.commitment ?? null,
    });

    // Canonical proof row. `is_real` is NEVER written — the BEFORE trigger
    // derives it from (scheme, proof_bytes), same doctrine as repid_agents.tier.
    const { data: proofRow, error: proofErr }: DbResult<{ id: number }> = await deps.db
      .from('repid_zkp_proofs')
      .insert({
        agent_id: subject.id,
        proof_type: 'POSTCARD',
        tier_proven: subject.tier ?? tierDerived,
        merkle_root: null,
        zk_commitment: zkCommitment,
        scheme: realScheme,
        proof_bytes: realProofBytes,
        statement,
      })
      .select('id')
      .single();
    if (proofErr || !proofRow) {
      throw new ZkpAuditError(
        'PERSIST_FAILED',
        `repid_zkp_proofs insert failed: ${proofErr?.message ?? 'no row returned'}`
      );
    }

    const digest = proofDigest(realProofBytes);
    const producedAt = now().toISOString();

    const { error: receiptErr }: DbResult<unknown> = await deps.db
      .from('zkp_audit_receipts')
      .insert({
        contract_id: contract.id,
        subject_agent_id: subject.id,
        buyer_agent_id: contract.buyer_agent_id,
        provider_agent_id: contract.provider_agent_id,
        zkp_proof_id: proofRow.id,
        statement,
        proof_sha256: digest,
        proof_size_bytes: proofSizeBytes,
        verifier_version: verification.verifier_version,
        self_verify_ok: true,
        tier_derived: tierDerived,
        x402_settlement_id: x402SettlementId,
      });
    if (receiptErr) {
      // No receipt ⇒ no delivery. The base class will catch this, leave the
      // contract escrowed, and apply NO SERVICE_FULFILLED deltas — so a
      // provider cannot harvest +10 for a proof that was never bound to the
      // contract that paid for it.
      throw new ZkpAuditError(
        'PERSIST_FAILED',
        `zkp_audit_receipts insert failed: ${receiptErr.message}`,
        { zkp_proof_id: proofRow.id }
      );
    }

    const requested = payload.requested_threshold;
    if (requested !== undefined && requested !== provenThreshold) {
      warn(
        `[zkp_audit] contract ${contract.id}: buyer requested threshold ${requested} but the prover proved ${provenThreshold}; ` +
          `reporting satisfaction by COMPARISON, never by re-verifying at a different threshold`
      );
    }

    log(
      `[zkp_audit] contract ${contract.id} produced real ${realScheme} proof id=${proofRow.id} ` +
        `subject=${subject.id} score=${provenScore} threshold=${provenThreshold} ` +
        `verifier=${verification.verifier_version} size=${proofSizeBytes}B`
    );

    return {
      verdict: 'PASS',
      service_type: ZKP_AUDIT_SERVICE_TYPE,
      contract_id: contract.id,
      subject_agent_id: subject.id,
      statement,
      proof_bytes: realProofBytes,
      proof_sha256: digest,
      proof_size_bytes: proofSizeBytes,
      scheme: realScheme,
      zkp_proof_id: proofRow.id,
      zk_commitment: zkCommitment,
      verifier_pkg: '@hyperdag/proof-verifier',
      verifier_version: verification.verifier_version,
      self_verify_ok: true,
      tier_derived: tierDerived,
      proven_threshold: provenThreshold,
      requested_threshold: requested ?? null,
      requested_threshold_honored:
        requested === undefined ? null : provenThreshold >= requested,
      score_source: scoreSource,
      produced_at: producedAt,
      honesty: HONESTY_BLOCK,
      patent_marker: 'P-001',
    };
  }

  return { produceAudit };
}

/* ============================================================================
 * Shared literals
 * ==========================================================================*/

/**
 * Shipped verbatim inside every deliverable. A buyer who reads only the JSON
 * still learns the two things a sales page might omit.
 */
export const HONESTY_BLOCK: ZkpAuditDeliverable['honesty'] = {
  score_is_public: true,
  is_score_privacy: false,
  statement_tier_is_unauthenticated: true,
  witness_source:
    "HyperDAG's own database (score_source=server_side_lookup). The proof is trustless about the RELATION (score > threshold) and TRUSTED about the WITNESS SOURCE.",
  contract_id_bound_in_stark: false,
  freshness_attested_by:
    'HyperDAG records (zkp_audit_receipts.created_at + the contract-bound zk_commitment). The STARK bytes carry NO timestamp. A buyer who needs freshness must re-buy, not re-read.',
};

/**
 * A per-proof nonce that also binds the contract. `postcardCommitmentPreimage`
 * is frozen (changing it invalidates every historical commitment), so the
 * contract id is folded into the NONCE component rather than added as a new
 * one. This is a records-level binding; it is not in the STARK transcript.
 */
export function contractBoundNonce(contractId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  const fresh = generateNonce();
  return (
    '0x' +
    createHash('sha256')
      .update(`${contractId}|${fresh}`)
      .digest('hex')
      .slice(0, 32)
  );
}
