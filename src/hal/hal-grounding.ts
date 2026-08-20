/**
 * hal-grounding.ts — the abstain / knowledge-boundary primitive, wired for the HAL grader.
 *
 * If an agent's answer carries a proof-carrying binding (P2), HAL verifies it: an answer that
 * CLAIMED grounding but can't prove every citation against the memory root is "ungrounded" and
 * SHOULD abstain (no proof ⇒ no answer). This is the HAL side of PROOF_CARRYING_RETRIEVAL_v0
 * (boundary-abstention).
 *
 * WHICH root, though — that is the whole of current-validity, and it is a caller obligation.
 * `verifyProofCarryingAnswer` is a pure function over the root the ANSWER asserts, which is the
 * correct shape for a verifier but means that, on its own, it proves "this was true at some root"
 * and NOT "this is true now". A pre-revocation answer replayed verbatim carries a root and a
 * witness that still agree, and verifies. Currency therefore lives HERE, at the integration
 * boundary: pass `current_memory_root` and the signal checks it; omit it and the signal reports
 * `root_current: null` and downgrades its own reason rather than claiming a currency it never
 * established. See `tests/hal-grounding-root-currency.test.ts` for the replay it exists to stop.
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
  /**
   * Was the root the answer asserts checked against a root this verifier independently trusts?
   *   true  — checked and equal: `grounded` is a statement about memory as it stands NOW.
   *   false — checked and DIFFERENT: the answer proves something about a superseded memory state.
   *   null  — NOT checked (no trusted root supplied). `grounded` then means only "provable at the
   *           root the ANSWER ITSELF asserts", which a replayed pre-revocation answer satisfies.
   * The null case is the honest default, not a failure: a caller that has no independent view of
   * current memory cannot establish currency, and must not be told that it did.
   */
  root_current: boolean | null;
}

export interface GroundingInput {
  proof_carrying_answer?: ProofCarryingAnswer | null;
  /**
   * The memory root this verifier independently believes is CURRENT (e.g. the agent's latest
   * committed/anchored root), NOT one read out of the answer. Omit when unknown — omitting
   * degrades the claim to "grounded at the asserted root", it never fabricates currency.
   */
  current_memory_root?: string | null;
}

/** Compute the grounding signal for a score event. Never throws (verifier is adversarial-input safe). */
export function computeGroundingSignal(input: GroundingInput, mode: GroundingMode = groundingMode()): GroundingSignal {
  const pca = input.proof_carrying_answer ?? null;
  const total = pca?.citations?.length ?? 0;
  const trustedRoot = input.current_memory_root ?? null;

  if (!pca) {
    return { mode, applicable: false, grounded: false, verified_citations: 0, total_citations: 0, would_abstain: false, reason: 'no_proof_carrying_answer', root_current: null };
  }
  if (mode === 'off') {
    return { mode, applicable: true, grounded: false, verified_citations: 0, total_citations: total, would_abstain: false, reason: 'not_computed(mode_off)', root_current: null };
  }

  // CURRENCY, BEFORE CRYPTO. A membership proof is only ever evidence about the root it was built
  // against. Re-verifying an OLD witness against the CURRENT root is the wrong instrument — it
  // fails on ANY memory movement, conflating "this fact was retracted" with "some other fact was
  // added". The right check is root equality against a root we trust: an answer asserting a
  // superseded root cannot establish current validity by any amount of valid crypto, and the agent
  // must re-derive against the live root (where a revoked value yields no witness at all).
  if (trustedRoot !== null && pca.memory_root !== trustedRoot) {
    return {
      mode,
      applicable: true,
      grounded: false,
      verified_citations: 0,
      total_citations: total,
      would_abstain: true,
      reason: 'ungrounded:stale_root',
      root_current: false,
    };
  }

  const v = verifyProofCarryingAnswer(pca);
  return {
    mode,
    applicable: true,
    grounded: v.grounded,
    verified_citations: v.verified_citations,
    total_citations: v.total_citations,
    would_abstain: !v.grounded,
    // 'grounded' is reserved for a root we actually checked. Without one the strongest true
    // statement is the weaker one, and the signal says so rather than overclaiming.
    reason: v.grounded ? (trustedRoot === null ? 'grounded_at_asserted_root' : 'grounded') : `ungrounded:${v.reasons.join(',')}`,
    root_current: trustedRoot === null ? null : true,
  };
}
