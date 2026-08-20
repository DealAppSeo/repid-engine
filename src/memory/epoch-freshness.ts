/**
 * epoch-freshness.ts — THE WITHHELD-EPOCH CHECK (D-094: *current*-valid memory).
 *
 * `auditCommitment` binds a leaf LIST to a ROOT. An EAS anchor binds that ROOT to a TIME and a
 * PURPOSE. Both are single-artifact properties, and both are satisfied — genuinely, with nothing
 * forged — by an agent that anchors epoch E+1 and then serves every citation against a still
 * perfectly valid epoch E. Every artifact is authentic; only the SET is incomplete. That is the
 * withholding attack, and `memory-publication.ts` names it as the thing it cannot see:
 *
 *     "It does not establish that the anchored epoch is the LATEST epoch — only that the published
 *      one is the anchored one. Detecting a withheld later epoch needs the anchor STREAM, not a
 *      single anchor."
 *
 * This module is that stream check. It is deliberately NOT a verification of anchors — an
 * observation is assumed to be an already-decoded, chain-sourced anchor — because the two questions
 * fail differently and collapsing them would hide which one failed.
 *
 * ── WHY A LAG BOUND AND NOT "MUST BE THE LATEST"
 *
 * The obvious rule is `presented === latest`. It is also the expensive one, and the cost was
 * measured rather than guessed (Beat 58 probe over the Beat 57 workload, seeds 1/2/3, 20k ops):
 *
 *   verification latency  |  structural max lag  |  false-abstention at maxEpochLag =
 *                         |  ceil(latency/epoch) |    0        1        2        3        >= max
 *   ----------------------|----------------------|------------------------------------------------
 *   40 ops  (epoch 50)    |          1           |  ~79-80%   0.00%    0.00%    0.00%    0.00%
 *   120 ops (epoch 50)    |          3           |  ~99%     ~99%    ~40%      0.00%    0.00%
 *   200 ops (epoch 50)    |          4           |  ~99%     ~99%    ~98%     ~98%      0.00%
 *
 * Two things follow, and neither is a matter of taste:
 *   1. `maxEpochLag = 0` refuses ~80-99% of answers whose cited fact is still live. It is sound and
 *      unusable — the same shape Beat 57 measured for LIVE_ROOT, arrived at from the other side.
 *   2. The dial is a STEP, not a slope. Any bound at or above the structural maximum costs exactly
 *      nothing; one epoch below it costs 40-99% depending on phase alignment. So the bound is not
 *      tuned, it is DERIVED: `maxEpochLag = ceil(max verification latency / epoch period)`. Picking
 *      it by feel lands either on "free" or on "broken", with almost no ground in between.
 *
 * ── THE PRECONDITION THAT MAKES ANY OF THAT MEAN ANYTHING (added Beat 60, from #262's finding)
 *
 * `epoch` is a PER-COMMITTER counter, not a clock. The first version of this module compared bare
 * numbers, and #262 measured what that costs: on an unfiltered stream, **100% of honest, maximally
 * fresh publications are refused**, ~all of them with `epoch-equivocation` — the module's strongest
 * accusation, the one documented as evidence an honest committer cannot produce. Two agents reaching
 * epoch 5 with different roots is not an attack, it is two agents having committed five times. Beat
 * 60 reproduced it under a different generator (2 and 12 agents, seeds 1/2/3) and extended the sweep
 * to `maxEpochLag = 50`: still 100%. The lag bound — the entire subject of the measurement above —
 * is INOPERATIVE on an unscoped stream, because equivocation refuses before lag is weighed.
 *
 * So `committer` is a required field on both sides and both comparisons scope to it. And the fix is
 * NOT free, which is worth stating because the obvious reading of #262's filtered column (0.0%
 * everywhere) is that it is: that column was measured with every agent's anchors present in the
 * stream. Scoping narrows the evidence base from stream-wide to per-committer, so the honest
 * boundary (`no-usable-observation`) becomes reachable in proportion to committers this verifier has
 * never seen. Measured over the same workload, 12 agents, `maxEpochLag = 1`:
 *
 *   per-committer coverage |  100%   |   75%    |   50%    |   25%
 *   refusal after scoping  |  0.0%   | 8-25%    | 43-53%   | 67-93%   (entirely no-usable-observation)
 *
 * The trade is still overwhelmingly worth making — the unscoped column is 100% refusal at EVERY
 * coverage — but it relocates the cost from a false accusation to a stated missing precondition, and
 * it turns "what feeds the observations" into an operational requirement rather than a detail. A
 * verifier that scans the whole EAS schema meets it; one that samples does not.
 *
 * ── WHAT THIS BUYS, PRECISELY
 *
 * Detection is MONOTONE IN OBSERVERS: a withholder is refused by any single verifier that has seen
 * a later epoch, and is not required to be refused by one that has not. So the guarantee is not
 * "withholding is impossible" but "withholding cannot be selective without being caught by whoever
 * has looked" — the property a public anchor stream is for.
 *
 * ── WHAT THIS DOES NOT BUY, stated so it is not assumed
 *
 *   • A verifier with NO usable observation cannot detect withholding, and this module does not
 *     pretend otherwise: it returns `no-usable-observation` and (under `requireObservation`) refuses.
 *     The attack is not closed, it is made VISIBLE — an undetectable condition becomes a stated,
 *     checkable precondition. That is the honest form of the claim.
 *   • It does not establish that `latestKnownEpoch` is the true latest. It bounds the presented
 *     epoch against what THIS verifier has seen, and nothing more.
 *   • An observation feed is trusted for what it asserts. A hostile feed can fabricate a later epoch
 *     or a conflicting root and get an honest agent refused. That is a DENIAL OF SERVICE against the
 *     committer, not a soundness break — the failure direction is toward refusal — but it is real,
 *     and it is why every verdict carries the `source` of the evidence that decided it, so a caller
 *     can weigh provenance instead of inheriting an anonymous boolean.
 *
 * Pure, TOTAL, and TERMINATING on untrusted input — the three properties this module family has had
 * to learn one at a time. The scan is bounded BEFORE it runs (Beat 53: a bound applied after the
 * work is not a bound), and the outer boundary catches a throwing accessor, because judging a field
 * requires dereferencing it.
 */

import type { Hex } from './leanimt-plus';

/**
 * One already-decoded anchor seen by this verifier.
 *
 * `epoch` and `root` are what the anchor asserts. `committer` is WHOSE epoch counter it is — the
 * `agentId` the anchor already carries (`memory-root-anchor.ts:22,38`, on-chain as the first field
 * of `PROOF_SCHEMA_DEF`); it is COMPARED, and it is what makes the other two comparable at all.
 * `source` is where the verifier got it (a chain scan, a peer, a prior interaction) and exists to be
 * reported back in evidence, never to be compared. The two are different questions — WHO committed
 * versus WHO TOLD ME — and a verifier holds many sources per committer and many committers per
 * source, so neither substitutes for the other.
 */
export interface AnchorObservation {
  epoch: number;
  root: Hex;
  committer: string;
  source: string;
}

export interface FreshnessPolicy {
  /**
   * How many epochs behind the newest observed epoch the presented one may be. Derive it as
   * `ceil(max verification latency / epoch period)` — see the table above; 0 is the expensive
   * choice, not the safe one.
   */
  maxEpochLag: number;
  /**
   * Fail-closed when the verifier holds no usable observation. Default true: "I have no evidence
   * about freshness" is not the same claim as "this is fresh", and only a caller that has said so
   * explicitly should get the weaker one.
   */
  requireObservation?: boolean;
}

/** Two observations (or an observation and the presentation) claiming one epoch with two roots. */
export interface EquivocationEvidence {
  epoch: number;
  rootA: Hex;
  rootB: Hex;
  sourceA: string;
  sourceB: string;
}

export interface FreshnessVerdict {
  ok: boolean;
  reasons: string[];
  /** Newest epoch among usable observations, or null when there are none. */
  latestKnownEpoch: number | null;
  /** `latestKnownEpoch - presentedEpoch`, or null when it could not be computed. */
  epochLag: number | null;
  /** Source of the observation that set `latestKnownEpoch`, for provenance weighing. */
  latestKnownSource: string | null;
  /** Non-null ⇒ the committer asserted two roots for one epoch. Refused unconditionally. */
  equivocation: EquivocationEvidence | null;
  /** Observations skipped as malformed. Reported, deliberately NOT a term of `ok` — see below. */
  skippedObservations: number;
  /**
   * Well-formed observations about a DIFFERENT committer, skipped as irrelevant. Counted apart from
   * `skippedObservations` on purpose: one is noise, the other is somebody else's perfectly good
   * anchor, and folding them together would make the noise counter read as ~the whole stream on any
   * real chain scan — which is precisely the confusion that produced the defect this field fixes.
   */
  otherCommitterObservations: number;
}

/**
 * Termination bound. A verifier's anchor stream is a scan result, so it is untrusted in LENGTH as
 * well as in content; the cap is checked before the loop rather than inside it.
 */
export const MAX_OBSERVATIONS = 65536;

const MAX_REASONS = 16;

function usable(o: unknown): o is AnchorObservation {
  if (typeof o !== 'object' || o === null) return false;
  const c = o as { epoch?: unknown; root?: unknown; committer?: unknown; source?: unknown };
  return (
    typeof c.epoch === 'number' && Number.isSafeInteger(c.epoch) && c.epoch >= 0 &&
    typeof c.root === 'string' && c.root.length > 0 &&
    typeof c.committer === 'string' && c.committer.length > 0 &&
    typeof c.source === 'string'
  );
}

const sameRoot = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Decide whether a presented (epoch, root) is fresh enough against an observed anchor stream.
 *
 * Clauses, and what each one stops:
 *   - `presented-epoch-not-a-safe-integer` — an epoch that cannot be placed in time is refused rather
 *     than coerced into one. Beat 56 found this exact clause computed, named, and then not read one
 *     module over, where a negative epoch verified `ok: true` while carrying its own refusal reason.
 *     It is not repeated here — but the mutation battery is precise about WHY, because the obvious
 *     answer is wrong: deleting the explicit `epochOk` term from the verdict kills **no test**. What
 *     actually refuses a malformed epoch is `epochLag`, which is computed as `null` when the epoch is
 *     unusable, so the `epochLag !== null` term does the work. Only when BOTH are removed (mutant D4)
 *     do the six `EPOCH IS A TIME` cases die. The explicit term is defence in depth, and it is
 *     described as such rather than credited with a guarantee another clause is providing.
 *   - `presented-root-malformed`         — nothing below can mean anything without a root to compare.
 *   - `presented-committer-malformed`    — and nothing below can mean anything without a SCOPE. With
 *     no committer every observation is out of scope, so the run also reaches `no-usable-observation`;
 *     the explicit clause is kept so the verdict says WHICH precondition failed rather than reporting
 *     a missing identity as missing evidence. Measured (Beat 60 battery): the FLAG is the guard —
 *     `committerOk` in the `ok` terms kills no test (M3), because the reason list already refuses.
 *     Under `requireObservation: false` the flag is all that stands between a committerless
 *     presentation and `ok: true`, which is why a case pins exactly that.
 *   - `observations-not-an-array`        — the stream is not a stream.
 *   - `observation-stream-too-large`     — refuse rather than scan an unbounded list.
 *   - `no-usable-observation`            — the honest boundary: withholding is undetectable from
 *     here. Verdict-bearing only under `requireObservation` (default true).
 *   - `epoch-equivocation`               — two roots for one epoch OF THE SAME COMMITTER, from any pair
 *     of sources INCLUDING the presentation itself. Strictly stronger evidence than lag: a withholder
 *     can be explained by latency, an equivocator cannot — which is exactly why it must be scoped.
 *     Unscoped, that sentence was false, and the module levelled its gravest charge at every honest
 *     agent in a twelve-agent fleet.
 *   - `stale-epoch`                      — the presented epoch lags the newest observed one by more
 *     than the policy allows. This is the withholding detection proper.
 *
 * `skippedObservations` is reported and is NOT a term of `ok`, which is a deliberate exception to
 * this family's fail-closed default and is safe for a reason worth writing down: if a malformed row
 * forced refusal, anyone who can write to the feed could refuse any agent at will. Skipping instead
 * gives an attacker who floods the feed with garbage exactly one outcome — no usable observation —
 * which `requireObservation` already refuses. Fail-closed is preserved through the absence of
 * evidence rather than through the presence of noise.
 */
export function checkEpochFreshness(
  presented: { epoch: number; root: Hex; committer: string },
  observations: readonly AnchorObservation[],
  policy: FreshnessPolicy,
): FreshnessVerdict {
  try {
    return checkEpochFreshnessInner(presented, observations, policy);
  } catch {
    return {
      ok: false, reasons: ['freshness-check-threw'], latestKnownEpoch: null, epochLag: null,
      latestKnownSource: null, equivocation: null, skippedObservations: 0, otherCommitterObservations: 0,
    };
  }
}

function checkEpochFreshnessInner(
  presented: { epoch: number; root: Hex; committer: string },
  observations: readonly AnchorObservation[],
  policy: FreshnessPolicy,
): FreshnessVerdict {
  const reasons: string[] = [];
  const flag = (m: string): void => { if (reasons.length < MAX_REASONS) reasons.push(m); };
  const bare = (extra: Partial<FreshnessVerdict> = {}): FreshnessVerdict => ({
    ok: false, reasons, latestKnownEpoch: null, epochLag: null, latestKnownSource: null,
    equivocation: null, skippedObservations: 0, otherCommitterObservations: 0, ...extra,
  });

  if (typeof presented !== 'object' || presented === null) { flag('presented-malformed'); return bare(); }
  const epochOk = typeof presented.epoch === 'number' && Number.isSafeInteger(presented.epoch) && presented.epoch >= 0;
  if (!epochOk) flag('presented-epoch-not-a-safe-integer');
  const rootOk = typeof presented.root === 'string' && presented.root.length > 0;
  if (!rootOk) flag('presented-root-malformed');
  // Without a committer there is no scope, and an unscoped comparison is the defect below. Refuse
  // rather than fall back to comparing every committer's counter — the fallback IS the bug.
  const committerOk = typeof presented.committer === 'string' && presented.committer.length > 0;
  if (!committerOk) flag('presented-committer-malformed');

  if (!Array.isArray(observations)) { flag('observations-not-an-array'); return bare(); }
  if (observations.length > MAX_OBSERVATIONS) { flag('observation-stream-too-large'); return bare(); }

  const maxLag = typeof policy?.maxEpochLag === 'number' && Number.isSafeInteger(policy.maxEpochLag) && policy.maxEpochLag >= 0
    ? policy.maxEpochLag
    : 0;
  const requireObservation = policy?.requireObservation !== false;

  let latestKnownEpoch: number | null = null;
  let latestKnownSource: string | null = null;
  let equivocation: EquivocationEvidence | null = null;
  let skippedObservations = 0;
  let otherCommitterObservations = 0;
  // First root seen per epoch, so a conflict is reported against the observation that established it.
  const rootByEpoch = new Map<number, { root: string; source: string }>();

  if (epochOk && rootOk && committerOk) rootByEpoch.set(presented.epoch, { root: presented.root, source: 'presentation' });

  for (const o of observations) {
    if (!usable(o)) { skippedObservations++; continue; }
    // SCOPE FIRST. Exact match, not case-folded: two ids differing only in case are two ids, and
    // inventing an identity equivalence here would silently merge two agents' counters — the very
    // thing this clause exists to prevent. A casing mismatch therefore costs observations (→ toward
    // refusal), never comparability (→ toward acceptance).
    if (!committerOk || o.committer !== presented.committer) { otherCommitterObservations++; continue; }
    const seen = rootByEpoch.get(o.epoch);
    if (seen === undefined) {
      rootByEpoch.set(o.epoch, { root: o.root, source: o.source });
    } else if (equivocation === null && !sameRoot(seen.root, o.root)) {
      equivocation = { epoch: o.epoch, rootA: seen.root, rootB: o.root, sourceA: seen.source, sourceB: o.source };
    }
    if (latestKnownEpoch === null || o.epoch > latestKnownEpoch) {
      latestKnownEpoch = o.epoch;
      latestKnownSource = o.source;
    }
  }

  if (equivocation !== null) flag('epoch-equivocation');

  if (latestKnownEpoch === null) {
    // `requireObservation` has to move the VERDICT, not merely the reason list. A caller that opted
    // into the weaker claim gets the weaker claim; a caller that did not gets a refusal. (The first
    // draft of this branch returned `ok: false` either way, which would have made the option the
    // same defect Beat 56 found next door: a term computed, named, and never read.)
    if (requireObservation) flag('no-usable-observation');
    return {
      ok: !requireObservation && epochOk && rootOk && committerOk && reasons.length === 0,
      reasons, latestKnownEpoch: null, epochLag: null, latestKnownSource: null,
      equivocation, skippedObservations, otherCommitterObservations,
    };
  }

  const epochLag = epochOk ? latestKnownEpoch - presented.epoch : null;
  if (epochLag !== null && epochLag > maxLag) flag('stale-epoch');

  // `reasons.length === 0` makes a clause added by a later beat verdict-bearing whether or not its
  // author remembers to wire it in. Measured honestly: removing it kills no test today (mutant D2),
  // exactly as its counterpart does in `memory-publication.ts`. It is fail-closed future-proofing,
  // and the battery does not validate it. The explicit terms beside it are kept so a reader can see
  // WHICH properties are required without reading every `flag` call site — `epochOk` among them is
  // redundant with `epochLag !== null` (mutant D1), and is defence in depth, not the load-bearing guard.
  const ok = epochOk && rootOk && committerOk && equivocation === null && epochLag !== null && epochLag <= maxLag && reasons.length === 0;
  return { ok, reasons, latestKnownEpoch, epochLag, latestKnownSource, equivocation, skippedObservations, otherCommitterObservations };
}

/**
 * The bound the measurement says to use. Both arguments are in the same unit (ops, seconds, blocks —
 * whatever the epoch period is counted in); the function does not care which, only that they agree.
 * Returns 0 for a non-positive or non-finite period, because "there is no epoch period" is not a
 * licence to accept an arbitrarily old snapshot.
 */
export function derivedMaxEpochLag(maxVerificationLatency: number, epochPeriod: number): number {
  if (!Number.isFinite(maxVerificationLatency) || !Number.isFinite(epochPeriod)) return 0;
  if (maxVerificationLatency <= 0 || epochPeriod <= 0) return 0;
  return Math.ceil(maxVerificationLatency / epochPeriod);
}
