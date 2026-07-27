/**
 * hal-grounding.ts — the abstain / knowledge-boundary primitive, wired for the HAL grader.
 *
 * If an agent's answer carries a proof-carrying binding (P2), HAL verifies it: an answer that
 * CLAIMED grounding but can't prove every citation against the committed memory root is
 * "ungrounded" and SHOULD abstain (no proof ⇒ no answer). This is the HAL side of
 * PROOF_CARRYING_RETRIEVAL_v0 (Patent #1 / #3 boundary-abstention).
 *
 * SHADOW-FIRST (mirrors REPID_PURPOSE_GATE_V3): `HAL_GROUNDING_MODE`
 *   - 'shadow' (DEFAULT): compute + log the grounding signal; NEVER affects the verdict/RepID.
 *   - 'enforce' (Sean GO, after measurement): neutralize any POSITIVE delta when an answer
 *      claimed grounding but can't prove it — a claimed-but-unprovable answer earns nothing.
 *   - 'off': skip entirely.
 * Byte-identical to today for all current traffic (no answer carries a proof-carrying answer yet
 * → applicable:false). Pure over the injected P2 verifier; no I/O.
 */
import { verifyProofCarryingAnswer, type ProofCarryingAnswer } from '../memory/proof-carrying-memory';

export type GroundingMode = 'off' | 'shadow' | 'enforce';

/** Resolve the mode from env; default 'shadow' (log-only, never affects scoring). */
export function groundingMode(env: string | undefined = process.env.HAL_GROUNDING_MODE): GroundingMode {
  const m = (env ?? '').trim().toLowerCase();
  if (m === 'enforce') return 'enforce';
  if (m === 'off') return 'off';
  return 'shadow';
}

export interface GroundingSignal {
  mode: GroundingMode;
  applicable: boolean;       // did the answer carry a proof-carrying binding at all?
  grounded: boolean;         // did it verify (binding intact + all citations current members)?
  verified_citations: number;
  total_citations: number;
  would_abstain: boolean;    // applicable && !grounded → an 'enforce' run would neutralize/abstain
  reason: string;
}

export interface GroundingInput { proof_carrying_answer?: ProofCarryingAnswer | null; }

/** Compute the grounding signal for a score event. Never throws (verifier is adversarial-input safe). */
export function computeGroundingSignal(input: GroundingInput, mode: GroundingMode = groundingMode()): GroundingSignal {
  const pca = input.proof_carrying_answer ?? null;
  const total = pca?.citations?.length ?? 0;

  if (!pca) {
    return { mode, applicable: false, grounded: false, verified_citations: 0, total_citations: 0, would_abstain: false, reason: 'no_proof_carrying_answer' };
  }
  if (mode === 'off') {
    return { mode, applicable: true, grounded: false, verified_citations: 0, total_citations: total, would_abstain: false, reason: 'not_computed(mode_off)' };
  }
  const v = verifyProofCarryingAnswer(pca);
  return {
    mode,
    applicable: true,
    grounded: v.grounded,
    verified_citations: v.verified_citations,
    total_citations: v.total_citations,
    would_abstain: !v.grounded,
    reason: v.grounded ? 'grounded' : `ungrounded:${v.reasons.join(',')}`,
  };
}
