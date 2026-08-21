/**
 * policy-version.ts — the string that makes a ledger row re-interpretable after
 * the weights move.
 *
 * WHY THE COLUMN EXISTS. Without it, tuning the scoring policy turns the history
 * into a mix of incomparable regimes, and "was this agent scored under the same
 * rules as that one?" becomes permanently unanswerable. That question cannot be
 * reconstructed later from anything else — which is why the column was added
 * before any row needed it.
 *
 * WHY IT IS DERIVED AND NOT DECLARED. `src/zkp/repid-delta-statement.ts` carries
 * a hand-bumped `version` string, and its own header records that the field HAS
 * ALREADY FAILED ONCE: the delta orientation was corrected, every delta the
 * formula produced changed, nobody bumped the string, and the commitment stayed
 * byte-identical. The file's verdict is exact — *"'Bumped by hand' is the defect,
 * not the instruction. A hand-maintained version behind a hash nobody reads is
 * wired at one end."*
 *
 * So this version is not a constant anyone remembers to change. It is a
 * fingerprint of what the policy actually DOES.
 *
 * WHY A BEHAVIOURAL FINGERPRINT AND NOT A LIST OF CONSTANTS. The obvious
 * implementation digests the parameters — `MAX_NEGATIVE_DELTA`, the confidence
 * amplifier, the caps. That fails twice over. Most of those numbers are inline
 * literals inside `deltaFor`, so digesting them means copying them here, and a
 * copy that drifts reports "unchanged" while the formula changed — the exact
 * failure above, rebuilt. And a constant list cannot see a LOGIC change:
 * `outcome-classification.ts` documents a real bug where clamping the final
 * product instead of the value component collapsed the confidence gradient at
 * high stakes, with every constant untouched.
 *
 * Probing the function catches both. Any change to a coefficient, a cap, a
 * branch, an ordering or a demotion rule moves at least one probe output, and
 * the version moves with it — with nothing duplicated and nothing to remember.
 *
 * WHY THIS DIGEST IS UNSALTED, WHEN `formulaCommitment` FAILS CLOSED WITHOUT A
 * SALT. That one commits to band edges that are not published; over low-entropy
 * private parameters an unsalted digest is brute-forceable in seconds, which
 * would publish the formula while appearing to protect it. This one digests the
 * observable behaviour of source that is already public in this repository, so
 * inverting it recovers nothing a reader could not simply read.
 *
 * That distinction is load-bearing, and it is a CONDITION, not a property: if a
 * private parameter is ever folded into this transcript, the digest must be
 * salted at the same moment. `tests/policy-version.test.ts` pins the transcript
 * so that becomes a deliberate act rather than a side effect.
 */
import { createHash } from 'crypto';
import { OutcomeClass, deltaFor, type OutcomeRecord } from './outcome-classification';
import { assessRisk } from './risk-tier';
import { CURRENT_FORMULA_PARAMS } from '../zkp/repid-delta-statement';

/**
 * Prefix, so a reader can tell what KIND of version string they are holding
 * before parsing it. `pol1` is the first policy-fingerprint scheme; a different
 * scheme takes a different prefix rather than silently producing digests that
 * cannot be compared with these.
 */
export const POLICY_VERSION_PREFIX = 'pol1';

/** Hex characters of digest retained. 16 hex = 64 bits — collision-free at any plausible number of policy revisions. */
const DIGEST_CHARS = 16;

/**
 * A fabricated agent id, used only to drive the probes.
 *
 * NIL-variant, per the fixture fence: PR #376 committed a proof lifted from the
 * production table — a real agent id and a real score — into this public
 * repository, and it cannot be withdrawn. No probe in this file may carry a
 * value any real agent could hold.
 */
const PROBE_AGENT_ID = '00000000-0000-0000-0000-000000000000';

/** A shape-valid but obviously fabricated settlement hash. */
const PROBE_PROOF = '0x' + '11'.repeat(32);

/**
 * The probe grid.
 *
 * Every outcome class, at confidences spanning the amplifier's full range, at
 * values spanning both sides of every cap and of the payment-proof threshold,
 * with and without an anchor, with and without a validation response.
 *
 * The value list is not arbitrary: `0` exercises the degenerate case, `1`
 * normalises the sqrt to 1, `10` sits exactly ON `PAYMENT_PROOF_REQUIRED_ABOVE`
 * (the boundary, where an off-by-one lives), `100` clears it, and `10000`
 * saturates the positive cap and the fault value cap together.
 */
const PROBE_CONFIDENCES = [0, 0.5, 1] as const;
const PROBE_VALUES = [0, 1, 10, 100, 10000] as const;
const PROBE_CLASSES = [
  OutcomeClass.SUCCESS_AUDITED,
  OutcomeClass.SUCCESS_UNAUDITED,
  OutcomeClass.FAILURE_AGENT_FAULT,
  OutcomeClass.FAILURE_COUNTERPARTY,
  OutcomeClass.FAILURE_INFRA,
  OutcomeClass.REFUSED_CORRECTLY,
  OutcomeClass.UNCERTAIN,
] as const;

/**
 * Risk-band probes. The band decides where an outcome's evidence has to live,
 * which is part of the policy a replay must reproduce even though it does not
 * change any delta.
 */
const RISK_PROBES: ReadonlyArray<{ service: number; stake: number; priors: number | null }> = [
  { service: 0, stake: 0, priors: null },
  { service: 1, stake: 0, priors: 0 },
  { service: 60, stake: 0, priors: 0 },
  { service: 60, stake: 0, priors: 50 },
  { service: 100, stake: 0, priors: 50 },
  { service: 0, stake: 700, priors: 0 },
  { service: 700, stake: 700, priors: 50 },
  { service: 1000, stake: 0, priors: 50 },
  { service: 5000, stake: 1, priors: null },
];

/**
 * Render the policy's behaviour as one canonical, line-oriented string.
 *
 * Exported so a test can pin it: a diff of two transcripts says exactly WHICH
 * behaviour moved, which a changed digest alone never can.
 */
export function policyTranscript(): string {
  const lines: string[] = [];

  // Folded in so that a hand-bump of the OTHER formula path still moves this
  // version. The two paths are distinct — bumping one has never implied the
  // other — and a ledger row is scored against whichever was in force.
  lines.push(`formula_params_version=${CURRENT_FORMULA_PARAMS.version}`);

  for (const cls of PROBE_CLASSES) {
    for (const conf of PROBE_CONFIDENCES) {
      for (const value of PROBE_VALUES) {
        for (const anchored of [false, true]) {
          for (const validated of [false, true]) {
            const record: OutcomeRecord = {
              class: cls,
              x402PaymentProof: anchored ? PROBE_PROOF : null,
              halCalibratedConfidence: conf,
              valueAtRisk: value,
              validationResponse: validated ? 100 : null,
              // Fixed, not `Date.now()`: a transcript that reads the clock
              // produces a different version on every call, and a version that
              // changes when nothing changed is worse than no version at all.
              timestamp: 0,
              agentId: PROBE_AGENT_ID,
              clientId: null,
            };
            const r = deltaFor(record);
            lines.push(
              `delta|${cls}|c=${conf}|v=${value}|p=${anchored ? 1 : 0}|val=${validated ? 1 : 0}` +
                `=>${r.delta}|${r.effectiveClass}|${r.demotionReason ? 1 : 0}`,
            );
          }
        }
      }
    }
  }

  for (const p of RISK_PROBES) {
    const a = assessRisk({
      serviceValueUsdc: p.service,
      stakeExposedUsdc: p.stake,
      priorInteractions: p.priors,
    });
    lines.push(
      `risk|s=${p.service}|k=${p.stake}|n=${p.priors === null ? 'null' : p.priors}` +
        `=>${a.band}|${a.effectiveValueAtRisk}|${a.noveltyMultiplier}`,
    );
  }

  return lines.join('\n');
}

let cached: string | null = null;

/**
 * The value written to `repid_score_events.policy_version`.
 *
 * Memoised: it is deterministic within a process, and the probe grid is a few
 * hundred pure calls that every scored event would otherwise repeat.
 */
export function currentPolicyVersion(): string {
  if (cached === null) {
    const digest = createHash('sha256').update(policyTranscript(), 'utf8').digest('hex');
    cached = `${POLICY_VERSION_PREFIX}-${digest.slice(0, DIGEST_CHARS)}`;
  }
  return cached;
}

/** Test seam. Never call this on a scoring path. */
export function __resetPolicyVersionCacheForTests(): void {
  cached = null;
}
