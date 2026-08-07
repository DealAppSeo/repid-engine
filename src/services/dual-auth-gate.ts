/**
 * dual-auth-gate.ts — LEG 5: the decision surface where BOTH authorities must agree.
 *
 * "Dual auth" is not two passwords. It is two INDEPENDENT authorities that a
 * single compromise cannot satisfy at once:
 *
 *   AGENT authority — an ERC-8004 identity (agentId) whose reputation is
 *                     attested by a ZK proof, not asserted by a header.
 *   HUMAN authority — the owner's standards, bound by `user_standards_hash`,
 *                     which the proof commits to.
 *
 * Stealing an agent's key does not let you act outside the standards its owner
 * bound; changing the standards does not let you impersonate the agent. Both, or
 * neither.
 *
 * FAIL-CLOSED IS THE POINT. Every unknown resolves to REFUSE. An unavailable
 * check is not a passing check — the demo proved this by accident on its first
 * run, when HAL was rate-limited and the gate correctly refused rather than
 * allowing on an unknown. That behaviour is now a named, tested property here.
 *
 * WHAT THIS DOES NOT DO. It does not verify the STARK itself — that is
 * `@hyperdag/proof-verifier`, already proven to reject forgeries (a flipped
 * byte, an inflated score, a raised threshold, a swapped agent). This module
 * consumes a verification RESULT and decides. Keeping the two separate means the
 * gate cannot accidentally become the thing that vouches for a proof it did not
 * check.
 */

/** Which authority failed. Named so a refusal is diagnosable, not just a "no". */
export type RefusalReason =
  | 'agent_identity_unverified'
  | 'proof_missing'
  | 'proof_invalid'
  | 'standards_unbound'
  | 'standards_mismatch'
  | 'threshold_not_met'
  | 'hal_unavailable'
  | 'hal_vetoed'
  | 'stale_proof';

export type Decision = 'ALLOW' | 'REFUSE';

export interface GateInput {
  /** ERC-8004 agentId. Absent => no agent authority. */
  agentId?: string | null;
  /** Result of client-side STARK verification. `undefined` = never checked. */
  proofVerified?: boolean;
  /** The statement the proof attests to. */
  proofStatement?: {
    agent_id?: string;
    repid_score?: number;
    threshold?: number;
    user_standards_hash?: string;
  } | null;
  /** The standards hash the OWNER bound. Compared against the proof's. */
  boundStandardsHash?: string | null;
  /** Threshold this action requires. */
  requiredThreshold: number;
  /** HAL verdict for the proposed action. `undefined` = not consulted. */
  halVerdict?: 'PASS' | 'FLAG' | 'VETO';
  /** Proof age in seconds, when known. */
  proofAgeSeconds?: number;
  /** Max acceptable proof age. Default 1h. */
  maxProofAgeSeconds?: number;
}

export interface GateResult {
  decision: Decision;
  reasons: RefusalReason[];
  /** Human-readable, safe to show a user. */
  explanation: string;
  /** Which authority satisfied, for observability. */
  authorities: { agent: boolean; human: boolean };
  /** Everything the decision rested on — auditable after the fact. */
  evidence: Record<string, unknown>;
}

const DEFAULT_MAX_AGE = 3600;

/**
 * Decide. Pure — no I/O, no clock, no network — so it is fully testable and a
 * caller cannot get a different answer than a reviewer reproducing it.
 */
export function evaluateGate(input: GateInput): GateResult {
  const reasons: RefusalReason[] = [];

  // ── AGENT AUTHORITY ───────────────────────────────────────────────────────
  const hasAgent = typeof input.agentId === 'string' && input.agentId.length > 0;
  if (!hasAgent) reasons.push('agent_identity_unverified');

  // `undefined` and `false` are DIFFERENT failures and must stay distinguishable:
  // "we never checked" is not "we checked and it failed". Collapsing them is how
  // an unchecked proof starts reading like a verified one.
  if (input.proofVerified === undefined) {
    reasons.push('proof_missing');
  } else if (input.proofVerified !== true) {
    reasons.push('proof_invalid');
  }

  // The proof must be ABOUT this agent. Without this, a valid proof for any
  // agent would authorise any other — the exact forgery the verifier rejects at
  // the crypto layer, which must not be reintroduced at the policy layer.
  const st = input.proofStatement ?? null;
  if (st && hasAgent && st.agent_id && st.agent_id !== input.agentId) {
    reasons.push('agent_identity_unverified');
  }

  // ── HUMAN AUTHORITY ───────────────────────────────────────────────────────
  const bound = input.boundStandardsHash;
  if (!bound) {
    reasons.push('standards_unbound');
  } else if (!st?.user_standards_hash) {
    // A proof that commits to no standards cannot satisfy the human authority,
    // however cryptographically valid it is.
    reasons.push('standards_mismatch');
  } else if (st.user_standards_hash !== bound) {
    reasons.push('standards_mismatch');
  }

  // ── THRESHOLD ─────────────────────────────────────────────────────────────
  // Read from the PROOF's statement, never from a caller-supplied score: the
  // whole point is that the number is attested rather than asserted.
  //
  // BOTH sides are checked for FINITENESS first, and that is not pedantry — it
  // was a live fail-open. Every comparison against NaN is false, so
  // `requiredThreshold: NaN` made `st.threshold < required` false, pushed no
  // reason, and the gate returned ALLOW. A caller passing a malformed number
  // could authorise anything. Caught by the malformed-input suite.
  //
  // Non-finite input is treated as a FAILED check, never a skipped one.
  if (!st || typeof st.threshold !== 'number' || !Number.isFinite(st.threshold)) {
    reasons.push('threshold_not_met');
  } else if (typeof input.requiredThreshold !== 'number' || !Number.isFinite(input.requiredThreshold)) {
    reasons.push('threshold_not_met');
  } else if (st.threshold < input.requiredThreshold) {
    reasons.push('threshold_not_met');
  }

  // ── FRESHNESS ─────────────────────────────────────────────────────────────
  // Same finiteness discipline as the threshold: a NaN age must not slip past
  // the freshness check by making every comparison false.
  const maxAge = Number.isFinite(input.maxProofAgeSeconds as number)
    ? (input.maxProofAgeSeconds as number)
    : DEFAULT_MAX_AGE;
  if (typeof input.proofAgeSeconds === 'number') {
    if (!Number.isFinite(input.proofAgeSeconds) || input.proofAgeSeconds > maxAge) {
      reasons.push('stale_proof');
    }
  }

  // ── HAL ───────────────────────────────────────────────────────────────────
  // Unavailable is REFUSE, not ALLOW. This is the property the demo exercised
  // when the endpoint was rate-limited.
  if (input.halVerdict === undefined) {
    reasons.push('hal_unavailable');
  } else if (input.halVerdict === 'VETO') {
    reasons.push('hal_vetoed');
  }

  const agentOk = !reasons.some((r) =>
    ['agent_identity_unverified', 'proof_missing', 'proof_invalid', 'stale_proof'].includes(r),
  );
  const humanOk = !reasons.some((r) => ['standards_unbound', 'standards_mismatch'].includes(r));

  const decision: Decision = reasons.length === 0 ? 'ALLOW' : 'REFUSE';

  return {
    decision,
    reasons,
    explanation: explain(decision, reasons),
    authorities: { agent: agentOk, human: humanOk },
    evidence: {
      agentId: input.agentId ?? null,
      proofVerified: input.proofVerified ?? null,
      provenThreshold: st?.threshold ?? null,
      requiredThreshold: input.requiredThreshold,
      standardsBound: !!bound,
      standardsMatch: !!bound && st?.user_standards_hash === bound,
      halVerdict: input.halVerdict ?? null,
      proofAgeSeconds: input.proofAgeSeconds ?? null,
    },
  };
}

const MESSAGES: Record<RefusalReason, string> = {
  agent_identity_unverified: 'the agent identity could not be established, or the proof is about a different agent',
  proof_missing: 'no reputation proof was presented — nothing was checked, which is not the same as passing',
  proof_invalid: 'the reputation proof failed verification',
  standards_unbound: 'no owner standards are bound to this agent, so the human authority cannot be satisfied',
  standards_mismatch: 'the proof commits to different standards than the owner bound',
  threshold_not_met: 'the proven reputation does not clear the threshold this action requires',
  hal_unavailable: 'HAL could not be consulted — an unavailable safety check is not a passing one',
  hal_vetoed: 'HAL vetoed the proposed action',
  stale_proof: 'the reputation proof is older than this action allows',
};

function explain(decision: Decision, reasons: RefusalReason[]): string {
  if (decision === 'ALLOW') {
    return 'Allowed: the agent proved its reputation clears the threshold, under the standards its owner bound, and HAL did not veto the action.';
  }
  // Every reason, not just the first. A caller fixing one blocker should not
  // have to rediscover the next by trial and error.
  return `Refused because ${reasons.map((r) => MESSAGES[r]).join('; ')}.`;
}
