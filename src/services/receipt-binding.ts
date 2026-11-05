/**
 * services/receipt-binding.ts — versioned Receipt v2 binding core (D-147). INERT, PURE, NOT WIRED.
 *
 * WHAT THIS IS. The signed combined receipt today commits to the HAL output and a verdict, but NOT to the
 * things a payout actually depends on: the exact deliverable, the exact contract, the exact evaluator
 * specification, the execution provenance, who the controller is, and which settlement it belongs to. So a
 * receipt can be verified-and-signed while the deliverable under it was swapped, the acceptance criteria were
 * softened, the PASS was minted for different work, the origin is stale or replayed, or the receipt is being
 * reused against a different settlement. This module is the v2 "binding" — the six facts bound into one
 * canonical object whose hash the engine signature would cover (D-130 / Chat + Grok advisory):
 *
 *   deliverable_sha256     the exact bytes attested to        (swap the deliverable  -> hash changes)
 *   work_statement_hash    the exact contract                 (swap the contract     -> hash changes)
 *   evaluation_spec_hash   the exact acceptance criteria       (soften the criteria   -> hash changes)
 *   execution_origin       the admission+grant it ran under    (stale / replayed      -> not authentic)
 *   controller_assurance   the owner-evidence class behind it  (administrative != proof of an owner, D-148)
 *   settled_evidence_id    the settlement it is bound to       (reuse elsewhere       -> id mismatch)
 *
 * HOW IT CATCHES EACH ATTACK. `buildReceiptBinding` computes the six fields from raw material; the engine would
 * embed the result in the receipt core, so the existing keccak content hash (and the service-key signature over
 * it) already covers it — no new signer. `verifyReceiptBinding` REBUILDS a binding from the material a holder
 * presents and compares field-by-field: any swapped deliverable, softened criteria, forged PASS (a PASS whose
 * deliverable/spec do not match the bound ones), or wrong settlement shows up as a named mismatch. Origin
 * authenticity (stale, replayed, forged admission) is NOT re-implemented here — it delegates to the existing,
 * tested `verifyExecutionOrigin` primitive, so one authority root set governs both.
 *
 * NO SILENT UPGRADE. A v1 receipt carries no binding. `receiptBinding(receipt)` returns null for it, and
 * `verifyReceiptBinding` refuses a material set with no bound binding — a legacy receipt is verified as v1
 * (unbound), never treated as if it carried v2 guarantees it does not have.
 *
 * WHAT THIS IS NOT (left for Sean — MAJOR, public-receipt change). Embedding the binding into the issued/
 * public combined receipt and signing over it is a change to the public receipt surface and a canonical
 * settlement input; per r23 / D-107 that is HITL. This file adds no field to any issued receipt, moves no
 * RepID, writes nothing, and has zero callers in any scoring or settlement path. It is the reviewable brick.
 */
import { createHash } from 'node:crypto';
import { keccakOfCanonicalJson, type Hex32 } from './receipt-issuer';
import { specWorkStatementHash, type CanonicalWorkStatement } from './work-statement-spec';
import { canonicalJson } from './work-statement';
import { verifyExecutionOrigin, type OriginRoot } from '../immune/execution-origin';

export const RECEIPT_BINDING_VERSION = 2 as const;

const sha256Hex = (s: string): string => '0x' + createHash('sha256').update(s, 'utf8').digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/** The owner-evidence class behind the receipt's controller — the agent-owner-resolver ladder (D-148). */
export type ControllerAssurance =
  | 'proven_human'
  | 'proven_wallet'
  | 'attested_unverified'
  | 'declared'
  | 'administrative'
  | 'none';

/** The origin evidence a receipt was produced under — passed straight to `verifyExecutionOrigin`. */
export interface OriginEvidence {
  mission_id: string;
  artifact_digest: string;
  experiment_id?: string;
  /** signed by the trusted runner (NOT the Maker). */
  admission: unknown;
  /** signed by the owner. */
  ownerGrant: unknown;
}

/** The six facts a v2 receipt binds into its signed content. Each is a hash or id — never raw material. */
export interface ReceiptBindingV2 {
  version: typeof RECEIPT_BINDING_VERSION;
  deliverable_sha256: string;
  work_statement_hash: string;
  evaluation_spec_hash: string;
  execution_origin: string;
  controller_assurance: ControllerAssurance;
  settled_evidence_id: string;
}

/** The raw material a binding is computed from — at issue time, and again at verify time from what a holder presents. */
export interface BindingMaterial {
  /** the exact deliverable bytes (DATA ONLY — hashed, never executed). */
  deliverableBytes: string;
  /** the canonical contract. */
  workStatement: CanonicalWorkStatement;
  /** the execution provenance (admission + owner grant + what they bind to). */
  origin: OriginEvidence;
  /** the strongest owner evidence class for this receipt's controller. */
  controllerAssurance: ControllerAssurance;
  /** the settlement / experiment id this receipt is bound to. */
  settledEvidenceId: string;
}

/** sha256 over the acceptance criteria ALONE — the evaluator specification, separable from the whole contract. */
export function evaluationSpecHash(statement: CanonicalWorkStatement): string {
  return sha256Hex(canonicalJson({ acceptance_criteria: statement.acceptance_criteria }));
}

/** sha256 over the origin evidence a receipt ran under — binds WHICH origin, so a swapped origin is detected. */
function originBindingHash(origin: OriginEvidence): string {
  return sha256Hex(
    canonicalJson({
      mission_id: origin.mission_id,
      artifact_digest: origin.artifact_digest,
      experiment_id: origin.experiment_id ?? null,
      admission: origin.admission,
      ownerGrant: origin.ownerGrant,
    }),
  );
}

/** Compute the v2 binding from raw material. Pure; writes nothing, signs nothing. */
export function buildReceiptBinding(m: BindingMaterial): ReceiptBindingV2 {
  return {
    version: RECEIPT_BINDING_VERSION,
    deliverable_sha256: sha256Hex(m.deliverableBytes),
    work_statement_hash: specWorkStatementHash(m.workStatement),
    evaluation_spec_hash: evaluationSpecHash(m.workStatement),
    execution_origin: originBindingHash(m.origin),
    controller_assurance: m.controllerAssurance,
    settled_evidence_id: m.settledEvidenceId,
  };
}

/** The keccak value the engine would commit to — matches how the receipt core is content-hashed and signed. */
export function bindingContentHash(binding: ReceiptBindingV2): Hex32 {
  return keccakOfCanonicalJson(binding);
}

/** A v1 receipt has no binding (null); a v2 receipt carries one. Never upgrades a v1 receipt to look v2. */
export function receiptBinding(receipt: unknown): ReceiptBindingV2 | null {
  if (!isObj(receipt)) return null;
  const b = receipt['binding'];
  return isObj(b) && b['version'] === RECEIPT_BINDING_VERSION ? (b as unknown as ReceiptBindingV2) : null;
}

/** Each way the presented material can fail to match what was signed — the named attacks (D-147). */
export type BindingMismatch =
  | 'deliverable_swapped' // the presented deliverable is not the bytes attested to (also catches a forged PASS for other work)
  | 'work_statement_changed' // the contract differs from the signed one
  | 'evaluation_spec_changed' // the acceptance criteria were softened/changed after signing
  | 'execution_origin_changed' // a different origin was substituted
  | 'controller_assurance_changed' // the controller-evidence class does not match
  | 'settlement_mismatch' // the receipt is being used against a different settlement (replay-across-settlement)
  | 'origin_not_authentic'; // stale / replayed / forged admission or grant (from verifyExecutionOrigin)

export interface BindingVerification {
  ok: boolean;
  mismatches: BindingMismatch[];
  /** when origin_not_authentic is present, the reasons `verifyExecutionOrigin` gave (e.g. admission_expired, admission_replayed). */
  originReasons: string[];
}

/**
 * Verify a holder's presented material against a signed binding. Rebuilds the binding from the material and
 * compares field-by-field, then checks origin authenticity via the existing primitive. Fail-closed: a missing
 * binding (a v1 receipt) is refused, never passed. Origin roots are passed through — with none pinned (the
 * inert default) origin is never authentic, so a real check must supply the external roots.
 */
export function verifyReceiptBinding(
  bound: ReceiptBindingV2 | null,
  presented: BindingMaterial,
  originOpts: {
    admissionRoots?: readonly OriginRoot[];
    ownerRoots?: readonly OriginRoot[];
    seenNonces?: ReadonlySet<string>;
    now?: number;
  } = {},
): BindingVerification {
  if (!bound || bound.version !== RECEIPT_BINDING_VERSION) {
    // No v2 binding to verify. A v1 receipt is NOT silently treated as if it passed v2 checks.
    return { ok: false, mismatches: [], originReasons: ['no_v2_binding'] };
  }
  const rebuilt = buildReceiptBinding(presented);
  const mismatches: BindingMismatch[] = [];
  if (rebuilt.deliverable_sha256 !== bound.deliverable_sha256) mismatches.push('deliverable_swapped');
  if (rebuilt.work_statement_hash !== bound.work_statement_hash) mismatches.push('work_statement_changed');
  if (rebuilt.evaluation_spec_hash !== bound.evaluation_spec_hash) mismatches.push('evaluation_spec_changed');
  if (rebuilt.execution_origin !== bound.execution_origin) mismatches.push('execution_origin_changed');
  if (rebuilt.controller_assurance !== bound.controller_assurance) mismatches.push('controller_assurance_changed');
  if (rebuilt.settled_evidence_id !== bound.settled_evidence_id) mismatches.push('settlement_mismatch');

  // Origin authenticity (stale / replay / forged admission) — delegate to the tested primitive, one root set.
  const origin = verifyExecutionOrigin(
    {
      admission: presented.origin.admission,
      ownerGrant: presented.origin.ownerGrant,
      binding: {
        mission_id: presented.origin.mission_id,
        artifact_digest: presented.origin.artifact_digest,
        experiment_id: presented.origin.experiment_id,
      },
    },
    originOpts,
  );
  if (!origin.authentic) mismatches.push('origin_not_authentic');

  return { ok: mismatches.length === 0, mismatches, originReasons: origin.authentic ? [] : origin.reasons };
}
