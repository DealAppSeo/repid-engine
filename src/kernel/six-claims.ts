/**
 * six-claims.ts — Mission 1 test #7: the canonical receipt envelope.
 *
 * A trust receipt must never collapse to one green "VERIFIED" badge. It makes SIX claims, each
 * stated SEPARATELY, each with its own status, its supporting evidence, and its explicit gaps, plus
 * a top-level "what this does not establish" line:
 *
 *   Integrity      — the record is whole and chained (hash + prev_hash), unsigned in the MVP.
 *   Authenticity   — who authorized it: the accountable owner is resolved and the policy signature holds.
 *   Observation    — what was actually seen: was a payment read back from the chain (MEASURED), or only authorized.
 *   Correctness    — was the content independently settled (holdout / known answer / person), or only voted on (PROVISIONAL).
 *   Authorization  — did the kernel permit the action (ALLOW), refuse it (DENY), or fail to check (NOT_CHECKED).
 *   Containment    — the execution boundary held: the tool ran only on ALLOW, and no hard-prohibited capability slipped through.
 *
 * FAIL CLOSED: a claim with insufficient evidence is NOT_CHECKED — it NEVER renders as VERIFIED.
 * There is deliberately NO top-level boolean: a consumer must read the six statuses, not a rollup.
 *
 * SHAPE: an in-toto Statement (https://in-toto.io/Statement/v1) over the receipt as subject, with a
 * HyperDAG predicate — an open, Sigstore/in-toto-compatible envelope rather than a proprietary one,
 * so a stranger can verify it with standard tooling. The subject digest is the receipt's own
 * keccak256 `receipt_hash` (algorithm named honestly as `keccak256`, not mislabeled `sha256`).
 */
import type { KernelReceipt } from './types';
import { KERNEL_RECEIPT_SCHEMA } from './types';

export type ClaimStatus = 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' | 'NOT_APPLICABLE';

export interface Claim {
  status: ClaimStatus;
  /** One plain sentence a stranger reads. */
  statement: string;
  /** Receipt facts that support the status. */
  supports: string[];
  /** What this claim does NOT establish, stated rather than implied. */
  gaps: string[];
}

export interface SixClaims {
  integrity: Claim;
  authenticity: Claim;
  observation: Claim;
  correctness: Claim;
  authorization: Claim;
  containment: Claim;
}

export const SIX_CLAIM_KEYS: ReadonlyArray<keyof SixClaims> = [
  'integrity', 'authenticity', 'observation', 'correctness', 'authorization', 'containment',
];

export const SIX_CLAIMS_PREDICATE_TYPE = 'https://hyperdag.dev/predicates/trust-receipt-six-claims/v1';

export interface InTotoStatement {
  _type: 'https://in-toto.io/Statement/v1';
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: typeof SIX_CLAIMS_PREDICATE_TYPE;
  predicate: {
    claims: SixClaims;
    /** The union of each claim's gaps and the decision's own does_not_attest. Never empty in practice. */
    what_this_does_not_establish: string[];
  };
}

const HEX32 = /^0x[0-9a-f]{64}$/;

function integrity(r: KernelReceipt): Claim {
  const hashOk = typeof r.header.receipt_hash === 'string' && HEX32.test(r.header.receipt_hash);
  const schemaOk = r.header.schema === KERNEL_RECEIPT_SCHEMA;
  const supports = [
    hashOk ? 'receipt_hash is a keccak256 over the canonical receipt' : 'receipt_hash missing or malformed',
    r.header.prev_hash ? `chained to prev_hash ${r.header.prev_hash.slice(0, 10)}…` : 'chain root (no prev_hash)',
    `schema ${String(r.header.schema)}`,
  ];
  return {
    status: hashOk && schemaOk ? 'VERIFIED' : 'NOT_CHECKED',
    statement: 'The record is whole and chained.',
    supports,
    gaps: ['unsigned — integrity rests on the keccak256 hash and the ledger chain, not a signature (header.signer is null)'],
  };
}

function authenticity(r: KernelReceipt): Claim {
  const ownerResolved = r.subject.owner.status === 'resolved' && !!r.subject.owner.wallet;
  const sig = r.decision.policy.signature;
  let status: ClaimStatus;
  if (sig === 'FAILED') status = 'FAILED';
  else if (ownerResolved && sig === 'VERIFIED') status = 'VERIFIED';
  else status = 'NOT_CHECKED';
  const gaps: string[] = [];
  if (!ownerResolved) gaps.push(`owner ${r.subject.owner.status}: the accountable owner was not positively resolved`);
  if (sig !== 'VERIFIED') gaps.push(`policy signature ${sig}`);
  return {
    status,
    statement: 'The action was authorized by the agent’s accountable owner.',
    supports: [
      `owner status ${r.subject.owner.status}`,
      r.subject.owner.wallet ? `owner wallet ${r.subject.owner.wallet.slice(0, 10)}…` : 'no owner wallet',
      `policy signature ${sig}`,
    ],
    gaps,
  };
}

function observation(r: KernelReceipt): Claim {
  if (r.payment.status === 'NOT_APPLICABLE') {
    return { status: 'NOT_APPLICABLE', statement: 'No payment was part of this call.', supports: ['payment NOT_APPLICABLE'], gaps: [] };
  }
  const measured = r.payment.settlement_evidence === 'MEASURED';
  const gaps: string[] = [];
  if (!measured) gaps.push('authorized is not observed: nothing was read back from the chain (settlement_evidence NOT_CHECKED)');
  if (r.payment.is_simulated) gaps.push('simulated: no real value moved');
  return {
    status: measured ? 'VERIFIED' : 'NOT_CHECKED',
    statement: 'A payment was observed settling on chain.',
    supports: [
      `payment status ${r.payment.status}`,
      `settlement_evidence ${r.payment.settlement_evidence}`,
      r.payment.tx_hash ? `tx ${r.payment.tx_hash.slice(0, 10)}…` : 'no tx hash',
    ],
    gaps,
  };
}

function correctness(r: KernelReceipt): Claim {
  const v = r.verification;
  if (v.status === 'NOT_APPLICABLE') {
    return { status: 'NOT_APPLICABLE', statement: 'No content verification was part of this call.', supports: ['verification NOT_APPLICABLE'], gaps: [] };
  }
  const settled = v.verdict_label === 'SETTLED' && (v.settled_by === 'holdout' || v.settled_by === 'known_answer' || v.settled_by === 'person');
  let status: ClaimStatus;
  if (v.status === 'FAILED') status = 'FAILED';
  else if (v.status === 'VERIFIED' && settled) status = 'VERIFIED';
  else status = 'NOT_CHECKED';
  const gaps: string[] = [];
  if (v.verdict_label !== 'SETTLED') {
    gaps.push('a vote alone is PROVISIONAL: votes support observation, not correctness — no holdout, known answer or person settled it');
  }
  if (v.is_simulated) gaps.push('simulated verification');
  return {
    status,
    statement: 'The content was independently settled as correct.',
    supports: [`verification ${v.status}`, `verdict_label ${v.verdict_label}`, `settled_by ${String(v.settled_by)}`],
    gaps,
  };
}

function authorization(r: KernelReceipt): Claim {
  const verdict = r.decision.verdict;
  const status: ClaimStatus = verdict === 'ALLOW' ? 'VERIFIED' : verdict === 'DENY' ? 'FAILED' : 'NOT_CHECKED';
  const reasonCodes = r.decision.reasons.map((x) => x.code);
  return {
    status,
    statement: 'The kernel permitted this action under a signed owner policy.',
    supports: [
      `verdict ${verdict}`,
      ...(reasonCodes.length ? [`reasons: ${reasonCodes.join(', ')}`] : []),
    ],
    gaps: verdict === 'ALLOW' ? [] : ['the action was not permitted (this is a refusal, not an authorization)'],
  };
}

function containment(r: KernelReceipt): Claim {
  // The gate's invariant: the tool runs iff the verdict is ALLOW. A receipt where `executed` is true
  // without an ALLOW would be a containment breach (and is rejected by the receipt validator). A
  // hard-prohibited capability that was refused is containment WORKING, not failing.
  const executedOnlyOnAllow = r.decision.executed ? r.decision.verdict === 'ALLOW' : true;
  // Read the reason code as the string it is: the hard-prohibition reason ('prohibited_action')
  // ships on its own branch/PR, so this must not depend on that ReasonCode literal existing here.
  const prohibitedRefused = r.decision.reasons.some((x) => (x.code as string) === 'prohibited_action');
  const gaps = [
    'tool_class is caller-asserted; there is no tool registry in the MVP',
    'the tool is a closure the kernel does not see into — what it did beyond the gated decision is not observed here',
  ];
  return {
    status: executedOnlyOnAllow ? 'VERIFIED' : 'FAILED',
    statement: prohibitedRefused
      ? 'The execution boundary held: a hard-prohibited capability was refused.'
      : 'The execution boundary held: the tool ran only under an ALLOW decision.',
    supports: [
      `executed ${r.decision.executed}`,
      `verdict ${r.decision.verdict}`,
      ...(prohibitedRefused ? ['prohibited_action refused'] : []),
    ],
    gaps,
  };
}

/** Build the six-claim in-toto Statement for a kernel receipt. PURE. Never a single collapsed badge. */
export function toSixClaimStatement(r: KernelReceipt): InTotoStatement {
  const claims: SixClaims = {
    integrity: integrity(r),
    authenticity: authenticity(r),
    observation: observation(r),
    correctness: correctness(r),
    authorization: authorization(r),
    containment: containment(r),
  };
  const digestHex = typeof r.header.receipt_hash === 'string' ? r.header.receipt_hash.replace(/^0x/, '') : '';
  const gapUnion = new Set<string>(r.decision.does_not_attest ?? []);
  for (const key of SIX_CLAIM_KEYS) for (const g of claims[key].gaps) gapUnion.add(`${key}: ${g}`);
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `kernel-receipt:${r.header.receipt_id}`, digest: { keccak256: digestHex } }],
    predicateType: SIX_CLAIMS_PREDICATE_TYPE,
    predicate: { claims, what_this_does_not_establish: [...gapUnion] },
  };
}
