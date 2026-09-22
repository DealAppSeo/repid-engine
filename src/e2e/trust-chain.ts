/**
 * trust-chain — the MVP sentence, as one chain of typed legs.
 *
 * The sentence this exists to test, stated once so no leg can drift from it:
 *
 *   "A human stakes testnet USDC. That stake is a hard limit on the total spend of
 *    every agent bound to that human. Two agents cannot both spend it. Every
 *    transaction moves the RepID of the human, the agent, and HAL."
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * WHY A CHAIN AND NOT A CHECKLIST
 *
 * Each leg below was independently "done" at some point, and the product still did not work,
 * because nothing ever asserted they connect. `human_agent_bindings` is empty while its flag
 * reads `on`; `stake_deposits` holds rows the gate never reads; the resolver that reads them
 * correctly had no caller for six weeks. Every one of those is green in isolation.
 *
 * So a leg here may only report PASS when the leg BEFORE it did. A chain that scores its links
 * separately is how you get four green tables that have never met.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * FIVE STATES, NOT TWO — AND `EXPECTED_FAIL` IS THE ONE THAT EARNS ITS KEEP
 *
 * The house vocabulary is MEASURED / APPROXIMATE / NOT_CHECKED / FAILED. This adds one:
 *
 *   EXPECTED_FAIL   a defect we have already measured, named, and chosen not to fix yet.
 *
 * It exists because of a specific trap. The concurrency leg CANNOT pass today: the gate's
 * `daily_used` is summed from an audit row whose insert is fire-and-forget, so two callers
 * read the same total and both authorise. A harness that omitted that leg would be green and
 * wrong; one that reported it as FAILED would be indistinguishable from a regression and would
 * be muted within a week, at which point a real failure reads the same as the noise.
 *
 * So EXPECTED_FAIL does not fail the run — and, deliberately, **an EXPECTED_FAIL that starts
 * PASSING is itself reported**. Negative findings decay silently in this codebase; someone
 * fixes the thing and no surface notices. A harness that only watches for degradation is half
 * a harness.
 */

export type LegStatus =
  | 'PASS'
  | 'FAILED'
  | 'NOT_CHECKED'
  | 'APPROXIMATE'
  | 'EXPECTED_FAIL'
  | 'EXPECTED_FAIL_NOW_PASSING'
  | 'BLOCKED';

export interface Leg {
  id: string;
  /** One line, in the product's words, not the schema's. */
  says: string;
  status: LegStatus;
  /** What was actually observed. Never a verdict — the evidence behind one. */
  detail: string;
  /** For EXPECTED_FAIL: where the defect is recorded, so the label is checkable. */
  ref?: string;
}

/** A leg that cannot be evaluated because an earlier leg did not pass. */
export function blocked(id: string, says: string, by: string): Leg {
  return {
    id,
    says,
    status: 'BLOCKED',
    detail:
      `not evaluated — "${by}" did not pass, and this leg's result would be meaningless ` +
      `without it. BLOCKED is not a failure of this leg and must not be read as one.`,
  };
}

/**
 * A defect we already understand. `observed` says whether it is STILL broken.
 *
 * Passing `observed: true` (i.e. it worked) is not quietly upgraded to PASS: it returns
 * EXPECTED_FAIL_NOW_PASSING, because "the thing we documented as broken is no longer broken"
 * is a fact somebody has to act on — the doc is now wrong.
 */
export function expectedFail(params: {
  id: string;
  says: string;
  ref: string;
  stillBroken: boolean;
  detail: string;
}): Leg {
  return {
    id: params.id,
    says: params.says,
    ref: params.ref,
    status: params.stillBroken ? 'EXPECTED_FAIL' : 'EXPECTED_FAIL_NOW_PASSING',
    detail: params.stillBroken
      ? params.detail
      : `${params.detail} — THIS WAS EXPECTED TO FAIL AND DID NOT. Re-check ${params.ref}: ` +
        `either it was fixed (update the reference) or this probe stopped testing it.`,
  };
}

export interface ChainVerdict {
  legs: readonly Leg[];
  /** House convention: 0 VERIFIED, 2 NOT_CHECKED, anything else FAILED. */
  exitCode: 0 | 1 | 2;
  summary: string;
}

/**
 * Score the chain.
 *
 * EXPECTED_FAIL does not fail the run; it is a known debt, and a run that went red on it would
 * be red every single time, which trains the reader to ignore red. Everything else that is not
 * a pass does fail, and NOT_CHECKED alone exits 2 rather than 0 — "we could not look" is never
 * "it works".
 */
export function scoreChain(legs: readonly Leg[]): ChainVerdict {
  const count = (s: LegStatus) => legs.filter((l) => l.status === s).length;

  const hardFail = count('FAILED');
  const nowPassing = count('EXPECTED_FAIL_NOW_PASSING');
  const notChecked = count('NOT_CHECKED');
  const blockedN = count('BLOCKED');
  const known = count('EXPECTED_FAIL');
  const passed = count('PASS') + count('APPROXIMATE');

  let exitCode: 0 | 1 | 2 = 0;
  if (hardFail > 0) exitCode = 1;
  else if (notChecked > 0 || blockedN > 0) exitCode = 2;

  const parts = [
    `${passed}/${legs.length} passed`,
    known ? `${known} known-broken (EXPECTED_FAIL)` : '',
    nowPassing ? `${nowPassing} EXPECTED_FAIL NOW PASSING — the record is stale` : '',
    blockedN ? `${blockedN} blocked by an earlier leg` : '',
    notChecked ? `${notChecked} NOT_CHECKED` : '',
    hardFail ? `${hardFail} FAILED` : '',
  ].filter(Boolean);

  return {
    legs,
    exitCode,
    summary: parts.join(' · '),
  };
}

/**
 * Does this tier let an agent spend WITHOUT collateral backing it?
 *
 * MEASURED 2026-09-21: `TIER_LIMITS` gives AUTONOMOUS and VETERAN `requires_stake: false`, and
 * `loadAuthorityContext` then sets their `stake_available` to the RepID score itself — so for
 * those two tiers the "stake" backing a payment is a reputation number, not money.
 *
 * It is UNREACHABLE TODAY: 0 agents sit in either tier, because `compute_tier(integer, uuid)`
 * demotes anything above ESTABLISHED that lacks 2 unique counterparties. That is why this is a
 * standing check rather than a bug report — the hole opens the moment one agent earns its
 * second counterparty, and nothing in the system would announce it.
 */
export const STAKE_BYPASSING_TIERS = ['AUTONOMOUS', 'VETERAN'] as const;

export function tierBypassesStake(tier: string | null | undefined): boolean {
  return (STAKE_BYPASSING_TIERS as readonly string[]).includes(String(tier ?? '').toUpperCase());
}
