/**
 * settled-interaction-scorer.ts — the seam between the chain and the ledger.
 *
 * `shadow-scoring.ts` is pure and must stay that way: a scoring path that is a
 * network call is a scoring path nobody tests. `x402-settlement-verifier.ts`
 * does I/O by definition. This is the one place they meet — resolve the
 * settlement against the chain FIRST, then hand the pure builder a proof whose
 * `verified` flag is an observation rather than an assertion.
 *
 * WHY THIS EXISTS AT ALL, rather than leaving callers to compose the two. A
 * verifier nothing calls is exactly the failure this codebase keeps finding: the
 * confession path had a fully-designed schema, a discount constant, invariant
 * tests, and **no working channel to the ledger** — and every reviewer who read
 * it concluded just-culture was handled. An unwired mechanism is worse than an
 * absent one, because absence is visible.
 *
 * ORDER IS LOAD-BEARING. Resolution happens BEFORE the delta is computed, not
 * after. `deltaFor` demotes an unanchored high-value success to UNCERTAIN, so a
 * proof that fails to resolve must be stripped before it reaches the builder —
 * scoring first and correcting later would mean the ledger briefly held a delta
 * the chain does not support.
 */
import { buildShadowScoreEvent, type SettledInteraction, type ShadowScoreResult } from './shadow-scoring';
import { resolvePaymentProof, type VerifySettlementResult } from './x402-settlement-verifier';

export interface ScoreSettledInteractionOptions {
  /**
   * Address that must have RECEIVED the payment — the provider agent's wallet.
   * Absent, the settlement cannot be resolved and the outcome is scored
   * unanchored.
   */
  payeeAddress?: string | null;
  minConfirmations?: number;
  tokenAddress?: string | null;
  policyVersion?: string;
  mode?: 'shadow' | 'applied';
}

export interface ScoredSettlement extends ShadowScoreResult {
  /** What the chain actually said. Absent only when no proof was supplied at all. */
  settlement?: VerifySettlementResult;
}

/**
 * Score a settled interaction with its payment proof resolved on chain.
 *
 * The caller still supplies the outcome class and the calibrated confidence —
 * those come from HAL, not from the chain. What this removes is the caller's
 * ability to assert that money moved.
 */
export async function scoreSettledInteraction(
  interaction: SettledInteraction,
  opts: ScoreSettledInteractionOptions = {},
): Promise<ScoredSettlement> {
  const claimed = interaction.paymentProof;

  // No proof at all is not a verification failure — there is nothing to check.
  // `deltaFor` already prices an unanchored claim; do not manufacture a verdict.
  if (!claimed) {
    return buildShadowScoreEvent(interaction, {
      ...(opts.policyVersion !== undefined ? { policyVersion: opts.policyVersion } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    });
  }

  if (!opts.payeeAddress) {
    // A proof we cannot resolve for want of a payee address must not be trusted
    // just because it is well-formed. Strip it and say why: the outcome is
    // scored as unanchored, which is what an unverifiable claim deserves.
    const built = buildShadowScoreEvent(
      { ...interaction, paymentProof: null },
      {
        ...(opts.policyVersion !== undefined ? { policyVersion: opts.policyVersion } : {}),
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      },
    );
    const settlement: VerifySettlementResult = {
      verified: false,
      evidence: 'NOT_CHECKED',
      reason: 'no payee address supplied — settlement could not be resolved',
    };
    return { ...built, settlement, ...annotate(built, settlement) };
  }

  const { proof, result } = await resolvePaymentProof(claimed, {
    payeeAddress: opts.payeeAddress,
    claimedValueUsdc: interaction.serviceValueUsdc,
    ...(opts.minConfirmations !== undefined ? { minConfirmations: opts.minConfirmations } : {}),
    ...(opts.tokenAddress !== undefined ? { tokenAddress: opts.tokenAddress } : {}),
  });

  const built = buildShadowScoreEvent(
    {
      ...interaction,
      // Only a RESOLVED proof travels onward. An unresolved one is dropped
      // rather than passed through — a truthy hash that resolves to nothing is
      // worse than no hash, because it satisfies a truthy check.
      paymentProof: result.verified ? proof : null,
      // The builder requires verification when asked; here the chain has
      // already answered, so re-asserting it would double-count the same check.
      requireVerifiedProof: false,
    },
    {
      ...(opts.policyVersion !== undefined ? { policyVersion: opts.policyVersion } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    },
  );

  return { ...built, settlement: result, ...annotate(built, result) };
}

/**
 * Fold the chain's verdict into the row's metadata.
 *
 * Recorded even when it is `NOT_CHECKED`, so a reader can tell an outcome scored
 * against a silent RPC apart from one scored against a chain that said no. Those
 * demote a claim identically and are not the same fact.
 */
function annotate(built: ShadowScoreResult, settlement: VerifySettlementResult): Pick<ShadowScoreResult, 'row'> {
  const payment = (built.row.metadata['payment'] ?? {}) as Record<string, unknown>;
  return {
    row: {
      ...built.row,
      metadata: {
        ...built.row.metadata,
        payment: {
          ...payment,
          settlement_verified: settlement.verified,
          settlement_evidence: settlement.evidence,
          settlement_reason: settlement.reason,
          ...(settlement.observedAmount !== undefined
            ? { observed_amount_smallest_unit: settlement.observedAmount.toString() }
            : {}),
          ...(settlement.confirmations !== undefined ? { confirmations: settlement.confirmations } : {}),
        },
      },
    },
  };
}
