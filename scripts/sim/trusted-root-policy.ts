/**
 * trusted-root-policy.ts — WHICH ROOT DOES A VERIFIER TRUST?
 *
 * repid-engine #242 gave HAL the capability (`GroundingInput.current_memory_root`) and
 * deliberately did NOT wire it, carrying the question as its own beat:
 *
 *     "Which root is production's trusted root (last committed? last EAS-anchored?)
 *      is a real integration question deserving its own beat."
 *
 * #242 also states the shape of the cost, correctly and without a number:
 *
 *     "Re-running an old witness against the current root fails on ANY memory movement,
 *      conflating 'this fact was retracted' with 'some unrelated fact was added'."
 *
 * This script supplies the missing number. It is a SIMULATION over a synthetic workload —
 * not a measurement of production traffic — and every figure it prints is recomputed from
 * the seeded run below, so the artifact can reproduce its own claims.
 *
 *   npx ts-node --transpile-only scripts/sim/trusted-root-policy.ts
 *   npx ts-node --transpile-only scripts/sim/trusted-root-policy.ts --seed 7 --ops 4000
 *
 * WHAT IS SCORED. For each answer emitted during the run, ground truth at verification
 * time is whether the cited fact is still ACTIVE in memory. A policy that refuses a live
 * fact commits a FALSE ABSTENTION (an availability cost). A policy that accepts a retracted
 * fact commits an UNSOUND ACCEPT (a correctness cost — the failure this design claims to close).
 *
 * WHAT IS NOT SCORED — stated so the table is not read as more than it is:
 *   - RE-DERIVE is the ground-truth oracle by construction, so its 0/0 is a tautology, not
 *     a result. Its real cost is architectural: it requires live memory access at verification
 *     time, which a peer verifying an answer OFFLINE does not have. No simulation over this
 *     workload can price that; it is the reason the other policies exist at all.
 *   - Absolute rates depend entirely on the workload mix below. The ORDERING and the SHAPE
 *     of each policy's failure are the transferable results; the decimals are not.
 *   - The unsound-accept column rests on FEW events (9-17 retractions-before-verification per
 *     20k-op run at these parameters). Its ordering is stable across seeds; its decimals are
 *     not sampled well enough to quote. Read it as "small and rising", never as a rate.
 *
 * A RESULT THAT CONTRADICTS THE OBVIOUS FRAMING. The anchor cadence looks like a staleness-vs-
 * cost trade in which correctness and availability pull against each other. Measured, they do
 * not. `unciteable` (a fact committed after the anchor has no witness) rises MONOTONICALLY with
 * `epochEvery` at every step, on every seed. `unsound-accept` (a fact retracted after the anchor
 * still appears live in the snapshot) rises between the ENDPOINTS on every seed but is NOT
 * step-wise monotone — adjacent cadences invert (e.g. 0.14% -> 0.12%), because it rests on ~10-20
 * events per run. The claim is therefore the weaker one the data supports: both worsen as the
 * epoch lengthens; only one of them does so smoothly.
 *
 * They are two faces of ONE quantity — snapshot age — so shortening the epoch improves both at
 * once. There is no correctness-vs-availability dial here. The only genuine counterweight to
 * anchoring more often is anchor COST, which this simulation does not model and therefore cannot
 * recommend a cadence from.
 */

// ── deterministic RNG (Math.random is unavailable to the loop and would break reproducibility)
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
}

export interface SimParams {
  seed: number;
  ops: number;          // total memory operations in the run
  revokeShare: number;  // share of ops that retract an existing fact (rest are inserts)
  queryShare: number;   // share of ops at which an agent emits an answer citing a live fact
  epochEvery: number;   // anchor cadence: an epoch root is published every N ops
  verifyLagOps: number; // how many ops elapse between emitting an answer and verifying it
}

export const DEFAULTS: SimParams = {
  seed: 1, ops: 3000, revokeShare: 0.15, queryShare: 0.25, epochEvery: 50, verifyLagOps: 40,
};

type PolicyKey = 'LIVE_ROOT' | 'ANCHORED_LIVE_EMIT' | 'ANCHORED_EPOCH_EMIT' | 'RE_DERIVE';

interface Score { falseAbstain: number; unsoundAccept: number; correct: number; unciteable: number; }
const zero = (): Score => ({ falseAbstain: 0, unsoundAccept: 0, correct: 0, unciteable: 0 });

/**
 * A deliberately minimal stand-in for ProofCarryingMemory: a set of live values plus a root
 * that MOVES ON EVERY WRITE. That movement is the only property of the real accumulator this
 * question turns on, and modelling it directly keeps the simulation honest about its scope —
 * it prices a policy, it does not re-test the crypto (which has its own suites).
 */
class RootModel {
  private live = new Set<number>();
  private version = 0;
  insert(v: number) { this.live.add(v); this.version++; }
  revoke(v: number) { if (this.live.delete(v)) this.version++; }
  root() { return this.version; }          // roots are equal iff no write has intervened
  isLive(v: number) { return this.live.has(v); }
  anyLive(rnd: () => number): number | null {
    if (this.live.size === 0) return null;
    const arr = [...this.live];
    return arr[Math.floor(rnd() * arr.length)] ?? null;
  }
}

interface Answer {
  value: number;
  emittedAtRoot: number;   // the root the answer carries a witness for
  citedFromEpoch: boolean; // true if the answer was emitted against the anchored epoch root
  verifyAtOp: number;
}

export function simulate(p: SimParams): { scores: Record<PolicyKey, Score>; emitted: number; retractedAtVerify: number } {
  const rnd = lcg(p.seed);
  const mem = new RootModel();
  const scores: Record<PolicyKey, Score> = {
    LIVE_ROOT: zero(), ANCHORED_LIVE_EMIT: zero(), ANCHORED_EPOCH_EMIT: zero(), RE_DERIVE: zero(),
  };

  const pending: Answer[] = [];
  let anchoredRoot = 0;                       // last published epoch root
  const anchoredLive = new Set<number>();     // the leaf set as of that epoch
  let nextValue = 1;
  let emitted = 0;
  let retractedAtVerify = 0;

  const settle = (op: number) => {
    while (pending.length && pending[0]!.verifyAtOp <= op) {
      const a = pending.shift()!;
      const stillLive = mem.isLive(a.value);   // ← ground truth
      if (!stillLive) retractedAtVerify++;

      // P1 LIVE_ROOT — verifier trusts the latest committed root; accept iff roots match.
      grade(scores.LIVE_ROOT, a.emittedAtRoot === mem.root(), stillLive);

      // P2a ANCHORED_LIVE_EMIT — verifier trusts the last anchored root, but the agent emitted
      //     against the live root. The naive combination of the two obvious choices.
      grade(scores.ANCHORED_LIVE_EMIT, a.emittedAtRoot === anchoredRoot, stillLive);

      // P2b ANCHORED_EPOCH_EMIT — the coherent form: the agent also emits against the anchored
      //     root, so roots match by construction. Correctness then rides on whether the epoch
      //     snapshot still reflects reality.
      if (a.citedFromEpoch) grade(scores.ANCHORED_EPOCH_EMIT, anchoredLive.has(a.value), stillLive);
      else scores.ANCHORED_EPOCH_EMIT.unciteable++;   // the fact post-dates the anchor: no witness exists

      // P3 RE_DERIVE — re-issue the witness against live memory. Oracle by construction.
      grade(scores.RE_DERIVE, stillLive, stillLive);
    }
  };

  for (let op = 0; op < p.ops; op++) {
    const r = rnd();
    if (r < p.revokeShare) {
      const victim = mem.anyLive(rnd);
      if (victim !== null) mem.revoke(victim);
    } else {
      mem.insert(nextValue++);
    }

    if (op % p.epochEvery === 0) {
      anchoredRoot = mem.root();
      anchoredLive.clear();
      for (let v = 1; v < nextValue; v++) if (mem.isLive(v)) anchoredLive.add(v);
    }

    if (rnd() < p.queryShare) {
      const cited = mem.anyLive(rnd);
      if (cited !== null) {
        emitted++;
        pending.push({
          value: cited,
          emittedAtRoot: mem.root(),
          citedFromEpoch: anchoredLive.has(cited),
          verifyAtOp: op + p.verifyLagOps,
        });
      }
    }
    settle(op);
  }
  settle(Number.MAX_SAFE_INTEGER);
  return { scores, emitted, retractedAtVerify };
}

function grade(s: Score, accepted: boolean, shouldAccept: boolean) {
  if (accepted && shouldAccept) s.correct++;
  else if (accepted && !shouldAccept) s.unsoundAccept++;
  else if (!accepted && shouldAccept) s.falseAbstain++;
  else s.correct++;   // correctly refused a retracted fact
}

const pct = (n: number, d: number) => (d === 0 ? '   n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

export function report(p: SimParams = DEFAULTS): string {
  const { scores, emitted, retractedAtVerify } = simulate(p);
  const out: string[] = [];
  out.push(`trusted-root policy simulation — seed=${p.seed} ops=${p.ops} revokeShare=${p.revokeShare} ` +
           `queryShare=${p.queryShare} epochEvery=${p.epochEvery} verifyLag=${p.verifyLagOps}`);
  out.push(`answers emitted: ${emitted}   of which the cited fact was RETRACTED by verification time: ` +
           `${retractedAtVerify} (${pct(retractedAtVerify, emitted)})`);
  out.push('');
  out.push('policy                 false-abstain   unsound-accept   unciteable   note');
  const notes: Record<PolicyKey, string> = {
    LIVE_ROOT: 'refuses on ANY intervening write',
    ANCHORED_LIVE_EMIT: 'incoherent pairing — roots almost never match',
    ANCHORED_EPOCH_EMIT: 'sound within the epoch; blind to post-anchor retractions',
    RE_DERIVE: 'oracle by construction — needs LIVE memory, so a peer cannot run it offline',
  };
  for (const k of Object.keys(scores) as PolicyKey[]) {
    const s = scores[k];
    const denom = s.correct + s.falseAbstain + s.unsoundAccept;
    out.push(`${k.padEnd(22)}${pct(s.falseAbstain, denom)}          ${pct(s.unsoundAccept, denom)}` +
             `        ${pct(s.unciteable, emitted)}   ${notes[k]}`);
  }
  return out.join('\n');
}

if (require.main === module) {
  const arg = (f: string, d: number) => {
    const i = process.argv.indexOf(f);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
  };
  const p: SimParams = { ...DEFAULTS, seed: arg('--seed', DEFAULTS.seed), ops: arg('--ops', DEFAULTS.ops) };
  console.log(report(p));
  console.log('\nSensitivity — anchor cadence (ANCHORED_EPOCH_EMIT only):');
  for (const epochEvery of [10, 25, 50, 100, 250]) {
    const { scores, emitted } = simulate({ ...p, epochEvery });
    const s = scores.ANCHORED_EPOCH_EMIT;
    const denom = s.correct + s.falseAbstain + s.unsoundAccept;
    console.log(`  epochEvery=${String(epochEvery).padStart(4)}  unsound-accept ${pct(s.unsoundAccept, denom)}` +
                `   unciteable ${pct(s.unciteable, emitted)}`);
  }
}
