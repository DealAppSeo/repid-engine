/**
 * multi-committer-freshness.ts — what the freshness check costs when the anchor stream is not
 * pre-filtered to one committer (Beat 59, verifying #260).
 *
 * `checkEpochFreshness` compares a presented epoch against the newest epoch in an observation
 * stream, and refuses `epoch-equivocation` when two roots are asserted for one epoch. Both
 * comparisons are between bare NUMBERS: `AnchorObservation` is `{ epoch, root, source }` and carries
 * no committer identity.
 *
 * But `epoch` is a PER-AGENT counter — `memory-root-anchor.ts:25` calls it "monotonically-increasing
 * epoch → carried as proofId", the entry hash mixes it in per entry (`proof-carrying-memory.ts:56`),
 * and the anchor payload carries `agentId` alongside it (`memory-root-anchor.ts:22,38`). So a
 * verifier that scans the EAS schema — which is what a chain scan returns — gets every agent's
 * anchors interleaved, and two agents reach epoch 5 with different roots as a matter of course.
 *
 * This simulation measures what that costs. Every publication it presents is HONEST and MAXIMALLY
 * FRESH: the agent's own current epoch, its own real root, nothing withheld. The only variable is
 * whether the stream the verifier holds was filtered to that agent first.
 *
 * Deterministic (LCG, no Math.random) so the table below reproduces exactly; the accompanying test
 * recomputes it rather than quoting it.
 */

import { checkEpochFreshness } from '../../src/memory/epoch-freshness';
import type { AnchorObservation } from '../../src/memory/epoch-freshness';
import type { Hex } from '../../src/memory/leanimt-plus';

export interface CommitterRow {
  seed: number;
  agents: number;
  maxEpochLag: number;
  /** Refusal rate against the raw multi-committer stream. */
  unfilteredRefusalPct: number;
  /** Refusal rate against the same stream filtered to the presenting agent. */
  filteredRefusalPct: number;
  /** Share of presentations refused with each reason, against the unfiltered stream. */
  reasonPct: Record<string, number>;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const rootOf = (agent: number, epoch: number): Hex => `0x${`${agent}_${epoch}`.padEnd(64, 'e')}` as Hex;

export function runMultiCommitter(
  seed: number,
  agents: number,
  answers: number,
  maxEpochLag: number,
  ticks = 200,
): CommitterRow {
  const rnd = lcg(seed);
  // Agents commit at different cadences — the ordinary case, not an adversarial one.
  const cadence = Array.from({ length: agents }, () => 1 + Math.floor(rnd() * 5));
  const stream: AnchorObservation[] = [];
  const currentEpoch = new Array<number>(agents).fill(0);

  for (let t = 0; t < ticks; t++) {
    for (let a = 0; a < agents; a++) {
      if (t % (cadence[a] ?? 1) === 0) {
        const next = (currentEpoch[a] ?? 0) + 1;
        currentEpoch[a] = next;
        stream.push({ epoch: next, root: rootOf(a, next), source: `chain:agent${a}` });
      }
    }
  }

  const own = (a: number): AnchorObservation[] => stream.filter((o) => o.source === `chain:agent${a}`);

  let unfilteredOk = 0;
  let filteredOk = 0;
  const reasonCount = new Map<string, number>();

  for (let i = 0; i < answers; i++) {
    const a = Math.floor(rnd() * agents);
    const epoch = currentEpoch[a] ?? 0;
    const presented = { epoch, root: rootOf(a, epoch) };

    const unfiltered = checkEpochFreshness(presented, stream, { maxEpochLag });
    const filtered = checkEpochFreshness(presented, own(a), { maxEpochLag });

    if (unfiltered.ok) unfilteredOk++;
    if (filtered.ok) filteredOk++;
    if (!unfiltered.ok) {
      for (const r of unfiltered.reasons) reasonCount.set(r, (reasonCount.get(r) ?? 0) + 1);
    }
  }

  const reasonPct: Record<string, number> = {};
  for (const [k, v] of reasonCount) reasonPct[k] = (100 * v) / answers;

  return {
    seed,
    agents,
    maxEpochLag,
    unfilteredRefusalPct: 100 * (1 - unfilteredOk / answers),
    filteredRefusalPct: 100 * (1 - filteredOk / answers),
    reasonPct,
  };
}

/** The sweep the report quotes. */
export function sweep(): CommitterRow[] {
  const rows: CommitterRow[] = [];
  for (const seed of [1, 2, 3]) {
    for (const agents of [2, 12]) {
      for (const lag of [0, 1, 3]) rows.push(runMultiCommitter(seed, agents, 500, lag));
    }
  }
  return rows;
}

if (require.main === module) {
  console.log('Every publication presented below is honest and maximally fresh (the agent\'s own');
  console.log('current epoch, its own root). "filtered" = the same stream reduced to that agent.\n');
  console.log('seed agents maxLag |  unfiltered   filtered | reasons (share of all presentations)');
  for (const r of sweep()) {
    const reasons = Object.entries(r.reasonPct)
      .map(([k, v]) => `${k}:${v.toFixed(1)}%`)
      .join(' ');
    console.log(
      `${String(r.seed).padStart(4)} ${String(r.agents).padStart(6)} ${String(r.maxEpochLag).padStart(6)} | ` +
        `${`${r.unfilteredRefusalPct.toFixed(1)}%`.padStart(11)} ${`${r.filteredRefusalPct.toFixed(1)}%`.padStart(10)} | ${reasons}`,
    );
  }
}
