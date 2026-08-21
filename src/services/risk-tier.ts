/**
 * risk-tier.ts — how much scrutiny does this interaction have to earn?
 *
 * Three bands, not two. Two bands force every interaction into "cheap and
 * unverifiable" or "expensive and attested", and the middle of the distribution
 * is where almost all real traffic sits. The middle band gets a batched Merkle
 * root (`src/zkp/merkle-root.ts`), which is verifiable at roughly the cost of
 * being unverifiable.
 *
 * VALUE AT RISK IS A MAX, NOT A SUM. `max(serviceValue, stakeExposed)`. Summing
 * them would double-count: the stake is collateral BACKING the service, not a
 * second independent exposure. A $50 job backed by a $500 stake risks $500 if
 * the stake is slashed, or $50 if it is not — never $550.
 *
 * NOVELTY UPLIFT, AND WHY IT ONLY EVER GOES UP. A first interaction between two
 * agents is riskier than the fiftieth at equal value: there is no history to
 * price against. So novelty multiplies value at risk UPWARD, and the multiplier
 * is bounded below by exactly 1.
 *
 * That bound is the whole design. If familiarity DISCOUNTED risk, a colluding
 * pair could manufacture fifty trivial interactions and buy a lower band for the
 * one real transfer — the wash-trading attack `x402-outcome-link.ts` exists to
 * price out, reintroduced through the back door. Because the multiplier floors
 * at 1, the most a farmer can achieve is removing their own uplift and landing
 * back on the honest raw band. The attack's best case is "no advantage".
 *
 * THRESHOLDS ARE NOT INVENTED HERE. `T1`/`T2` default to the `repid_config`
 * anchors that already govern claim handling (`claim_auto_threshold_usdc`,
 * `claim_peer_court_min_usdc`). A third, independent set of money bands would be
 * a fourth place to disagree about what "high value" means.
 */

/** Where an outcome's evidence has to live. */
export enum RiskBand {
  /** Below T1. Off-chain scoring only. */
  OFF_CHAIN = 'OFF_CHAIN',
  /** T1..T2 inclusive. Off-chain scoring plus a periodically anchored Merkle root. */
  BATCHED = 'BATCHED',
  /** Above T2. Individual on-chain attestation. */
  ATTESTED = 'ATTESTED',
}

/**
 * Whether the interaction count behind the novelty uplift was actually looked up.
 *
 * Two states here, and that is deliberate rather than an exception to the
 * four-state vocabulary: this field reports whether ONE lookup happened, and a
 * lookup cannot "fail to pass". A count that could not be read is NOT_CHECKED —
 * an absence — and is handled as such below.
 */
export type NoveltyEvidence = 'MEASURED' | 'NOT_CHECKED';

/**
 * Defaults mirroring `repid_config`. Passed in explicitly by production callers
 * that have read the live config; these exist so the module is usable and
 * testable without a database round trip.
 */
export const DEFAULT_T1_USDC = 100;
export const DEFAULT_T2_USDC = 1000;

/**
 * Maximum novelty uplift, applied at zero prior interactions. 0.5 means a
 * never-before-seen pair is priced as 1.5x its face value.
 *
 * Chosen, not measured — there is no interaction history to fit it against yet.
 * It is APPROXIMATE and stays that way until real pair histories exist. What is
 * NOT arbitrary is its sign and its floor; those are the load-bearing parts.
 */
export const NOVELTY_MAX_UPLIFT = 0.5;

export interface RiskInput {
  /** Price of the service, in USDC. */
  serviceValueUsdc: number;
  /** Stake exposed to slashing behind this interaction, in USDC. */
  stakeExposedUsdc: number;
  /**
   * Completed prior interactions between this exact pair of agents.
   *
   * `null` means NOBODY LOOKED. It does not mean zero. It is handled as zero for
   * the arithmetic — the conservative direction, since zero produces the LARGEST
   * uplift and therefore the most scrutiny — but the assessment reports
   * `NOT_CHECKED` so a reader is never told a guess was a measurement.
   */
  priorInteractions: number | null;
  thresholds?: { t1: number; t2: number };
}

export interface RiskAssessment {
  band: RiskBand;
  /** `max(serviceValue, stakeExposed)`, before novelty. */
  valueAtRisk: number;
  noveltyMultiplier: number;
  /** What the band was actually computed from. */
  effectiveValueAtRisk: number;
  noveltyEvidence: NoveltyEvidence;
  thresholds: { t1: number; t2: number };
  /** The exact inputs, so a reviewer can recompute the band after the fact. */
  basis: Record<string, unknown>;
}

function nonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * `1 + uplift/(1 + priors)`. Monotonically decreasing in `priors`, asymptotic to
 * 1 from above, and never below it.
 *
 * A negative count is treated as zero rather than rejected: a corrupt counter
 * should produce the most cautious band, not an exception on the scoring path.
 */
export function noveltyMultiplier(priorInteractions: number | null): number {
  const priors = priorInteractions === null ? 0 : Math.max(0, Math.floor(priorInteractions));
  return 1 + NOVELTY_MAX_UPLIFT / (1 + priors);
}

/**
 * Band an interaction. Pure — no clock, no I/O — so the band stored on an event
 * is recomputable from the event itself.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const t1 = input.thresholds?.t1 ?? DEFAULT_T1_USDC;
  const t2 = input.thresholds?.t2 ?? DEFAULT_T2_USDC;
  if (!(t2 >= t1)) {
    // Not a clamp. Inverted thresholds would make the middle band empty and
    // silently route everything to one extreme; that is a config error, and a
    // config error that changes which outcomes reach the chain must be loud.
    throw new Error(`risk thresholds inverted: t1=${t1} must be <= t2=${t2}`);
  }

  const serviceValue = nonNegative(input.serviceValueUsdc);
  const stakeExposed = nonNegative(input.stakeExposedUsdc);
  const valueAtRisk = Math.max(serviceValue, stakeExposed);

  const multiplier = noveltyMultiplier(input.priorInteractions);
  const effectiveValueAtRisk = Math.round(valueAtRisk * multiplier * 1e6) / 1e6;

  let band: RiskBand;
  if (effectiveValueAtRisk < t1) band = RiskBand.OFF_CHAIN;
  else if (effectiveValueAtRisk <= t2) band = RiskBand.BATCHED;
  else band = RiskBand.ATTESTED;

  return {
    band,
    valueAtRisk,
    noveltyMultiplier: Math.round(multiplier * 1e6) / 1e6,
    effectiveValueAtRisk,
    noveltyEvidence: input.priorInteractions === null ? 'NOT_CHECKED' : 'MEASURED',
    thresholds: { t1, t2 },
    basis: {
      serviceValueUsdc: serviceValue,
      stakeExposedUsdc: stakeExposed,
      priorInteractions: input.priorInteractions,
      noveltyMaxUplift: NOVELTY_MAX_UPLIFT,
    },
  };
}

/** Does this band require an individual on-chain attestation? */
export function requiresIndividualAttestation(band: RiskBand): boolean {
  return band === RiskBand.ATTESTED;
}

/** Does this band's evidence go into a batched Merkle root? */
export function requiresBatchedAnchor(band: RiskBand): boolean {
  return band === RiskBand.BATCHED;
}
