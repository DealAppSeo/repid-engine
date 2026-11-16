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
import {
  paymentAnchorVerifyMode,
  shadowCheckPaymentAnchor,
  type AnchorDeps,
  type ShadowAnchorResult,
} from './payment-anchor-verify';

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
  /** Test seam for the payment-anchor check (see `anchorShadow`). Production reads service_contracts / x402_settlements / payment_anchor_claims. */
  anchorDeps?: AnchorDeps;
}

export interface ScoredSettlement extends ShadowScoreResult {
  /** What the chain actually said. Absent only when no proof was supplied at all. */
  settlement?: VerifySettlementResult;
  /** The payment-anchor check. Absent when PAYMENT_ANCHOR_VERIFY_MODE is off or no proof was supplied. */
  anchorCheck?: ShadowAnchorResult;
}

/**
 * Run the flag-gated payment-anchor check (payment-anchor-verify.ts). It takes the payee, payer and
 * price from `interaction.contractId`'s record, binds the tx to that contract and refuses a replay.
 * The answer goes to `metadata.payment.anchor_check`; no delta changes.
 *
 * Off: returns undefined and reads nothing (the Supabase adapter is not even imported). Never throws
 * into scoring.
 */
async function anchorShadow(
  interaction: SettledInteraction,
  opts: ScoreSettledInteractionOptions,
): Promise<ShadowAnchorResult | undefined> {
  const claimed = interaction.paymentProof;
  if (!claimed) return undefined;
  const mode = paymentAnchorVerifyMode();
  if (mode.effective === 'off') return undefined;
  try {
    const deps: AnchorDeps =
      opts.anchorDeps ??
      (await import('./payment-anchor-db.js').then((m) => ({ loadTerms: m.dbAnchorTerms, replay: m.dbAnchorReplayStore() })));
    return (
      (await shadowCheckPaymentAnchor(
        { txHash: claimed.txHash, chainId: claimed.chainId, contractId: interaction.contractId ?? null },
        deps,
        mode,
      )) ?? undefined
    );
  } catch {
    return undefined;
  }
}

/** Record the anchor check beside the payment metadata. Shadow: the delta is untouched. */
function withAnchor(scored: ScoredSettlement, check: ShadowAnchorResult | undefined): ScoredSettlement {
  if (!check) return scored;
  const payment = (scored.row.metadata['payment'] ?? {}) as Record<string, unknown>;
  return {
    ...scored,
    anchorCheck: check,
    row: {
      ...scored.row,
      metadata: {
        ...scored.row.metadata,
        payment: {
          ...payment,
          anchor_check: {
            mode: check.mode.effective,
            requested_mode: check.mode.requested,
            verdict: check.verdict,
            reason: check.reason,
            would_refuse: check.would_refuse,
            contract_id: check.contract_id,
            ...(check.settlement_kind ? { settlement_kind: check.settlement_kind } : {}),
            ...(check.net_units ? { net_units: check.net_units } : {}),
            ...(check.bound_contract_id ? { bound_contract_id: check.bound_contract_id } : {}),
          },
        },
      },
    },
  };
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

  const anchor = await anchorShadow(interaction, opts);

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
      code: 'no_payee',
      reason: 'no payee address supplied — settlement could not be resolved',
    };
    return withAnchor({ ...built, settlement, ...annotate(built, settlement) }, anchor);
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

  return withAnchor({ ...built, settlement: result, ...annotate(built, result) }, anchor);
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
