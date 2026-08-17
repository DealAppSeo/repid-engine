/**
 * promotion-ledger.ts — a mechanism earns authority by measurement, or it does not get it.
 *
 * TERMINOLOGY: promote / park / reject, and "promotion gate", are borrowed from the
 * OmegaHive meta-algorithm (Goertzel, *Seeding RSI Toward ASI*, 2026-08-07).
 * See docs/RSI-ADOPTION-PLAN.md §3.2. `park` is the state we did not previously have a
 * name for and consequently could not record.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE MEASURED FAILURE THIS EXISTS FOR
 * ════════════════════════════════════════════════════════════════════════════════
 * Three mechanisms in this repo are stalled in three different ways and none of the three
 * stalls is written down anywhere a reader would find it:
 *
 *   • `src/layers/constitutional-audit.ts` — gated off since 2026-07-05 by
 *     `CONSTITUTIONAL_AUDIT_ENABLED`, with no recorded criterion for what would turn it on.
 *   • `src/services/anfis-comma.ts` — a complete 5-input/5-rule ANFIS forward pass with
 *     ZERO call sites.
 *   • `docs/SHADOW_REJECT_CAPABILITY.md` — a designed fix with a written verification plan,
 *     deferred behind another branch, unbuilt.
 *
 * These read as three separate stalls. They are one missing institution: there is no place to
 * say "this was considered, here is the state it is in, and here is what would change it".
 * So each was recorded in whatever surface its author had to hand, and each became invisible.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE ONE INVARIANT
 * ════════════════════════════════════════════════════════════════════════════════
 *     A mechanism may be PROMOTED only on MEASURED evidence.
 *
 * Not on a plan to measure, not on a design review, not on an env var someone flipped. That
 * single rule is the difference between this file and a status table, and it is the reason
 * `Evidence` is a tagged union instead of an optional field: an optional field can be omitted
 * and a promotion would still typecheck.
 *
 * THREE OUTCOMES, NEVER TWO — and here there are genuinely three kinds of "no number":
 *
 *   MEASURED     a ruled measurement against a named incumbent.
 *   NOT_CHECKED  nobody looked. The honest state of most things most of the time.
 *   REFUSED      somebody looked and the INSTRUMENT declined to yield a number — a degraded
 *                run, a corpus mismatch, incomparable rulers. This is distinct from
 *                NOT_CHECKED and collapsing them would hide the most interesting case, which
 *                is a measurement that was attempted and could not be trusted. Mirrors
 *                src/hal/measurement-integrity.ts, where a degraded run yields no quality
 *                number rather than a lower one.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS REUSES RATHER THAN REBUILDS
 * ════════════════════════════════════════════════════════════════════════════════
 * `MeasurementRuler` / `RuledMeasurement` / `rulerFaults` come from src/hal/measurement-ruler.ts
 * unchanged. docs/RSI-ADOPTION-PLAN.md §3.2 states that if this needed new measurement
 * primitives the design would be wrong, so it defines none: this module decides whether a
 * STATE CHANGE is justified, never what a number is.
 *
 * PURITY: no I/O, no env reads, no DB, no clock. A ledger is a value; persisting one is the
 * caller's business.
 */

import {
  MeasurementRuler,
  RuledMeasurement,
  rulerFaults,
} from '../hal/measurement-ruler';

/** ISO-8601 instant. */
export type Iso8601 = string;

/**
 * Where a mechanism stands.
 *
 * - `shadow`   — running for observation, holding no authority.
 * - `promoted` — holds authority. Reachable ONLY through MEASURED evidence.
 * - `parked`   — measured or considered, not adopted, and expected to be revisited. Requires a
 *                re-open condition; a park with no trigger is a rejection that nobody wanted to
 *                write down.
 * - `rejected` — not adopted, not expected to be revisited. Kept, never deleted, so the same
 *                idea cannot be re-proposed as novel.
 */
export type MechanismState = 'shadow' | 'promoted' | 'parked' | 'rejected';

/** Why a state is what it is. Three kinds; see the header. */
export type Evidence =
  | {
      kind: 'MEASURED';
      measurement: RuledMeasurement;
      /** The implementation this was measured AGAINST. A delta needs two sides. */
      incumbentId: string;
    }
  | { kind: 'NOT_CHECKED'; why: string }
  | { kind: 'REFUSED'; why: string };

/** One mechanism's standing. */
export interface LedgerEntry {
  /** Stable id. Points at code, a doc, or a Module Space implementation id. */
  readonly mechanismId: string;
  /** One line: what the mechanism is. */
  readonly description: string;
  /** The Module Space boundary it sits at, when it has one declared. */
  readonly spaceId?: string;
  readonly state: MechanismState;
  readonly evidence: Evidence;
  readonly decidedAt: Iso8601;
  /** REQUIRED when `state` is 'parked': what would cause this to be picked up again. */
  readonly reopenCondition?: string;
  /** Where the reader should go to see for themselves. */
  readonly reference: string;
}

export interface LedgerFault {
  code:
    | 'PROMOTED_WITHOUT_MEASUREMENT'
    | 'PARKED_WITHOUT_REOPEN_CONDITION'
    | 'MEASUREMENT_WITHOUT_USABLE_RULER'
    | 'MEASUREMENT_WITHOUT_INCUMBENT'
    | 'EMPTY_REASON'
    | 'DUPLICATE_MECHANISM_ID'
    | 'EMPTY_MECHANISM_ID';
  mechanismId: string;
  message: string;
}

/**
 * Everything structurally wrong with one entry.
 *
 * PROMOTED_WITHOUT_MEASUREMENT is the invariant this module exists for. The others are the
 * ways an entry could look like it satisfies that invariant without doing so: a measurement
 * whose ruler is unusable is not a measurement (src/hal/measurement-ruler.ts refuses to record
 * one), and a measurement with no named incumbent is a number with nothing to be a delta from.
 */
export function entryFaults(entry: LedgerEntry): LedgerFault[] {
  const faults: LedgerFault[] = [];
  const id = entry.mechanismId;

  if (id.trim() === '') {
    faults.push({
      code: 'EMPTY_MECHANISM_ID',
      mechanismId: id,
      message: 'ledger entry has no mechanism id',
    });
  }

  if (entry.state === 'promoted' && entry.evidence.kind !== 'MEASURED') {
    faults.push({
      code: 'PROMOTED_WITHOUT_MEASUREMENT',
      mechanismId: id,
      message:
        `'${id}' is marked promoted on ${entry.evidence.kind} evidence. ` +
        `A mechanism may hold authority only on a ruled measurement against a named incumbent — ` +
        `promotion by intention is the thing this ledger exists to prevent.`,
    });
  }

  if (entry.state === 'parked' && (entry.reopenCondition ?? '').trim() === '') {
    faults.push({
      code: 'PARKED_WITHOUT_REOPEN_CONDITION',
      mechanismId: id,
      message:
        `'${id}' is parked with no re-open condition. A park with no trigger is a rejection ` +
        `nobody wanted to write down, and it will never be revisited.`,
    });
  }

  if (entry.evidence.kind === 'MEASURED') {
    const faultsOnRuler = rulerFaults(entry.evidence.measurement.ruler);
    if (faultsOnRuler.length > 0) {
      faults.push({
        code: 'MEASUREMENT_WITHOUT_USABLE_RULER',
        mechanismId: id,
        message: `'${id}' carries a measurement whose ruler is unusable: ${faultsOnRuler.join(', ')}`,
      });
    }
    if (entry.evidence.incumbentId.trim() === '') {
      faults.push({
        code: 'MEASUREMENT_WITHOUT_INCUMBENT',
        mechanismId: id,
        message: `'${id}' carries a measurement with no named incumbent; a delta needs two sides`,
      });
    }
  } else if (entry.evidence.why.trim() === '') {
    faults.push({
      code: 'EMPTY_REASON',
      mechanismId: id,
      message:
        `'${id}' records ${entry.evidence.kind} with an empty reason. ` +
        `An empty string reads as "nothing there" and the reader fills the silence (LESSONS §1).`,
    });
  }

  return faults;
}

/** Every fault across a ledger, including cross-entry ones. */
export function ledgerFaults(entries: readonly LedgerEntry[]): LedgerFault[] {
  const faults: LedgerFault[] = entries.flatMap(entryFaults);

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.mechanismId)) {
      faults.push({
        code: 'DUPLICATE_MECHANISM_ID',
        mechanismId: e.mechanismId,
        message: `two ledger entries share the mechanism id '${e.mechanismId}'`,
      });
    }
    seen.add(e.mechanismId);
  }

  return faults;
}

/** Thrown when a state change cannot be justified by the evidence attached to it. */
export class UnjustifiedPromotionError extends Error {
  readonly faults: LedgerFault[];
  constructor(faults: LedgerFault[]) {
    super(`[promotion-ledger] refusing the entry: ${faults.map((f) => f.message).join('; ')}`);
    this.name = 'UnjustifiedPromotionError';
    this.faults = faults;
  }
}

/** Build an entry, refusing any that is not justified by its own evidence. */
export function record(entry: LedgerEntry): LedgerEntry {
  const faults = entryFaults(entry);
  if (faults.length > 0) throw new UnjustifiedPromotionError(faults);
  return entry;
}

/**
 * Whether `entry` may move to `promoted` right now, and if not, why not.
 *
 * Separate from `record` because the interesting question at a gate is usually "may this be
 * promoted YET", asked of an entry that is currently in shadow.
 */
export function promotionBlockers(entry: LedgerEntry): string[] {
  if (entry.evidence.kind === 'MEASURED') {
    const blockers = entryFaults({ ...entry, state: 'promoted' }).map((f) => f.message);
    return blockers;
  }
  return [
    `'${entry.mechanismId}' has ${entry.evidence.kind} evidence (${entry.evidence.why}). ` +
      `Promotion requires a ruled measurement against a named incumbent.`,
  ];
}

/** One readable line per entry, for a report or a PR body. */
export function describeEntry(entry: LedgerEntry): string {
  const ev =
    entry.evidence.kind === 'MEASURED'
      ? `MEASURED vs ${entry.evidence.incumbentId}: ${entry.evidence.measurement.citation}`
      : `${entry.evidence.kind}: ${entry.evidence.why}`;
  const reopen = entry.reopenCondition ? ` | re-open when: ${entry.reopenCondition}` : '';
  return `${entry.mechanismId} [${entry.state.toUpperCase()}] ${ev}${reopen}`;
}

/** Count of entries by state — the one-line health of the loop. */
export function tally(entries: readonly LedgerEntry[]): Record<MechanismState, number> {
  const out: Record<MechanismState, number> = { shadow: 0, promoted: 0, parked: 0, rejected: 0 };
  for (const e of entries) out[e.state] += 1;
  return out;
}

export type { MeasurementRuler, RuledMeasurement };
