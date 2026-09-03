/**
 * Earned RepID that is NOT in the score — and whether it is coming.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SURFACES, AND THE BUG IT REFUSES TO HIDE [MEASURED 2026-09-03]
 * ════════════════════════════════════════════════════════════════════════════════
 * A new agent's first rewards do not raise `current_repid`. During a vesting cliff
 * the score route deliberately leaves the score alone and routes the reward to
 * `vested_repid` — correct anti-Sybil behaviour, and invisible to the person it
 * happens to. The passport showed the unmoved score and said nothing about the
 * balance sitting beside it, so the honest reading of a working system was
 * "nothing happened".
 *
 * Measuring that surface turned up something larger: **nothing releases the
 * balance when the cliff ends.** No code path and no database function anywhere
 * mentions `vested_repid` except the writer that accumulates into it and the two
 * reads that report it. Agents whose cliff expired MONTHS ago still hold their
 * full vested balance, and some of them still sit at exactly the starting RepID.
 * The cliff is a one-way valve: RepID goes in and never comes out.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THIS MODULE DOES NOT FIX THAT, ON PURPOSE
 * ════════════════════════════════════════════════════════════════════════════════
 * Crediting the stranded balance would move real scores in an append-only ledger
 * that other systems treat as evidence, retroactively, for agents that have since
 * been read, ranked and attested at their current numbers. That is a decision with
 * an owner, not a cleanup — the same call the ecosystem-need multiplier gets in
 * CLAUDE.md, and for the same reason.
 *
 * What is safe, and what this does: say the true thing on the surface. `MATURED`
 * is the rung that makes the bug impossible to keep missing — it names a balance
 * that is owed and not delivered, in the response a user is already looking at,
 * every time it is read. `tests/vesting-status.test.ts` and the
 * `check:vesting-not-stranded` script make it fail loudly rather than accumulate
 * quietly for another three months.
 *
 * THE LADDER:
 *
 *   NONE      no vesting balance and no cliff. Nothing to say; the score is the score.
 *   VESTING   a cliff is running. Earned RepID is held and WILL be released on the
 *             date given. This is the state the product means to be in.
 *   MATURED   the cliff has passed and the balance is STILL HELD. Not "vesting" —
 *             overdue. Reporting this as VESTING would repeat the original error one
 *             level up: a delay presented as normal when nothing is coming.
 *   HELD      a balance with no cliff date recorded. We cannot say when, or whether,
 *             it releases. NOT_CHECKED, not a promise.
 */

export type VestingState = 'NONE' | 'VESTING' | 'MATURED' | 'HELD';

export interface VestingRow {
  vested_repid?: number | null;
  vesting_cliff_ends_at?: string | Date | null;
}

export interface VestingBlock {
  state: VestingState;
  /** RepID earned and not counted in `repid_score`. Never negative. */
  vested_repid: number;
  cliff_ends_at: string | null;
  /** The score a holder would have if the balance were credited. NOT a promise that it will be. */
  score_including_vested: number;
  note: string;
}

export function deriveVestingState(row: VestingRow, now: number = Date.now()): VestingState {
  const vested = Math.max(0, Number(row.vested_repid ?? 0) || 0);
  const rawCliff = row.vesting_cliff_ends_at;
  const cliffMs = rawCliff ? new Date(rawCliff).getTime() : NaN;
  const haveCliff = Number.isFinite(cliffMs);

  // No balance: nothing is being withheld, whatever the cliff says. A cliff with an
  // empty balance is just a new agent that has not earned yet.
  if (vested <= 0) return 'NONE';

  // A balance we cannot date. We will not guess a release we have no evidence for.
  if (!haveCliff) return 'HELD';

  return cliffMs > now ? 'VESTING' : 'MATURED';
}

export const VESTING_NOTES: Record<VestingState, string> = {
  NONE: 'No RepID is being withheld. The score shown is the whole score.',
  VESTING:
    'RepID has been earned and is held during the initial vesting period, so the score below ' +
    'does not include it yet. This is deliberate: it makes a newly created identity expensive ' +
    'to farm. The held amount and the release date are both shown.',
  MATURED:
    'RepID has been earned, the vesting period has PASSED, and the balance has still not been ' +
    'added to the score. This is not a delay — it is a known gap in the release path, reported ' +
    'here rather than hidden. The earned amount is shown; treat the score as understating it.',
  HELD:
    'RepID has been earned and is not counted in the score, and no release date is recorded for ' +
    'it. We cannot say when it will be credited, so we do not claim one.',
};

export function vestingBlock(
  row: VestingRow & { current_repid?: number | null },
  now: number = Date.now(),
): VestingBlock {
  const state = deriveVestingState(row, now);
  const vested = Math.max(0, Number(row.vested_repid ?? 0) || 0);
  const score = Number(row.current_repid ?? 0) || 0;
  const rawCliff = row.vesting_cliff_ends_at;
  const cliffMs = rawCliff ? new Date(rawCliff).getTime() : NaN;
  return {
    state,
    vested_repid: vested,
    cliff_ends_at: Number.isFinite(cliffMs) ? new Date(cliffMs).toISOString() : null,
    score_including_vested: score + vested,
    note: VESTING_NOTES[state],
  };
}
