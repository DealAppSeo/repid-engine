/**
 * A_eff — ported from trinity-ecosystem's `lib/trustshell/authority-policy.ts`
 * (`effectiveAuthority`), which is the tested, real implementation of the locked formula in
 * `docs/policy/authority-policy.v0.5.yaml` (trinity-ecosystem) / `grants-authority.v0.md`:
 *
 *   A_eff = min(R_route, 100 * sqrt(S_real)) * 1[builder_score >= builder_floor]
 *
 * The formula and the NOT_CHECKED-on-unknown-collateral discipline are copied verbatim in
 * spirit — same constants, same fail-closed shape. What's NOT ported, because it cannot be:
 * trinity-ecosystem's `rRoute` (routing RepID) is the output of that repo's own decay-envelope
 * / soft-landing sigma engine (`decay-dryrun.ts`), which has no equivalent here. That repo's
 * own header names the exact failure this matters for:
 *
 *   "ROUTING RepID, never the ledger value, while the decay envelope is open. Using r_ledger
 *   here makes A_eff rise because decay was latent."
 *
 * repid-engine cannot compute R_route. Callers in this repo pass `repid_agents.current_repid`
 * (the LEDGER value) as `rRoute` — an explicit, named approximation, not a silent substitution.
 * Every `EffectiveAuthority` this function returns is stamped `rRouteIsLedgerApproximation:
 * true` so nothing downstream can present it as the real, sigma-adjusted figure. If decay is
 * latent on the grantor's agent, this can OVERSTATE A_eff — the mint-floor checks that use this
 * (G1/G3 in grants-authority.v0.md) are therefore MEASURED against this conservative-in-name-
 * only proxy, and explicitly NOT MEASURED against the true locked formula. Do not remove this
 * caveat by "fixing" the approximation without also wiring a real R_route source.
 */

export const BUILDER_FLOOR = 500; // locked: authority-policy.v0.5.yaml `authority.builder_floor`
export const ANTI_WHALE_MULTIPLIER = 100; // locked: the `100` in `100 * sqrt(S_usd)`

export type AuthorityOutcome = 'MEASURED' | 'NOT_CHECKED';

export interface EffectiveAuthority {
  /** Dollars/points a principal may back a grant with. Null when it could not be computed. */
  aEff: number | null;
  outcome: AuthorityOutcome;
  /** Which term actually bound the result — a denial you cannot explain is not actionable. */
  bindingTerm: 'r_route' | 'anti_whale_sqrt_stake' | 'builder_floor' | null;
  detail: string;
  /** Always true here — see file header. Never silently drop this flag downstream. */
  rRouteIsLedgerApproximation: true;
}

export interface AuthorityInputs {
  /**
   * repid_agents.current_repid for the grantor. NAMED APPROXIMATION for R_route — see file
   * header. Not the sigma-adjusted routing value.
   */
  rRoute: number;
  /** REAL collateral only (non-simulated stake_deposits, summed). Null = unmeasured, not zero. */
  stakeUsd: number | null;
  /** builders.current_repid for the resolved builder owning the grantor's agent. */
  builderScore: number;
}

/**
 * `A_eff = min(R_route, M * sqrt(S_usd)) * 1[builder >= floor]`.
 *
 * Null collateral yields NOT_CHECKED rather than zero: unknown backing is not the same as no
 * backing, and the two must not resolve to the same spending decision by accident.
 */
export function effectiveAuthority(input: AuthorityInputs): EffectiveAuthority {
  if (input.stakeUsd === null) {
    return {
      aEff: null,
      outcome: 'NOT_CHECKED',
      bindingTerm: null,
      detail: 'collateral could not be measured — unknown backing is not zero backing',
      rRouteIsLedgerApproximation: true,
    };
  }

  if (input.builderScore < BUILDER_FLOOR) {
    return {
      aEff: 0,
      outcome: 'MEASURED',
      bindingTerm: 'builder_floor',
      detail: `builder ${input.builderScore} is below the floor of ${BUILDER_FLOOR}`,
      rRouteIsLedgerApproximation: true,
    };
  }

  const antiWhale = ANTI_WHALE_MULTIPLIER * Math.sqrt(input.stakeUsd);
  const bound = Math.min(input.rRoute, antiWhale);

  return {
    aEff: bound,
    outcome: 'MEASURED',
    bindingTerm: bound === antiWhale && antiWhale < input.rRoute ? 'anti_whale_sqrt_stake' : 'r_route',
    detail:
      `min(r_route(ledger-approx) ${input.rRoute}, ${ANTI_WHALE_MULTIPLIER} * sqrt(${input.stakeUsd}) = ` +
      `${antiWhale.toFixed(2)}) = ${bound.toFixed(2)}`,
    rRouteIsLedgerApproximation: true,
  };
}
