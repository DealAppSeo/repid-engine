/**
 * PROVIDER-LIST INTEGRITY — the width half of the ruler, refused when its input is corrupt.
 * OUTPUT_PATH: src/hal/provider-width.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/hal/measurement-ruler.ts` made a HAL accuracy number carry its ruler: corpus identity AND
 * configuration width. The width half is derived from the persisted list of providers that answered.
 * That list is corrupt in production, so a width computed from it is a number with no meaning — and
 * the whole point of the ruler is defeated by a plausible-looking wrong width.
 *
 * Verified against the live DB on 2026-08-03 (`hal_runner_results`, 1825 rows, `text[]` column
 * confirmed via `information_schema`):
 *
 *   1419 rows  `hal_providers_used = '{}'`      — empty list; zero providers recorded
 *      1 row   NULL
 *     81 rows  a single element `used:1` (69) or `used:2` (12)  — a COUNT smuggled into a NAME array
 *
 * The `used:N` shape is the dangerous one, and 12 rows prove why: `array_length` of `{"used:2"}` is
 * **1**, so a naive width reads ONE family where the run actually reached TWO. The corruption does not
 * merely lose information, it silently understates the very quantity the ruler exists to pin down.
 *
 * Worse, the only non-corrupt element values in the entire table are `litellm` (324), `gemini` (10) and
 * `groq` (3). `litellm` is a GATEWAY — a transport that fronts many families — so even the rows that
 * look clean do not record a family. A run whose providers are `{litellm}` has an UNKNOWN family width,
 * not a width of 1. Counting a gateway as one family would overstate independence for exactly the
 * quorum HAL's veto depends on.
 *
 * SO: this module REFUSES. It never coerces, never parses `used:2` back into the number 2, and never
 * substitutes 0 for a missing list. A width computed from corrupt data must fail loudly rather than
 * quietly produce a number, because a quiet number gets quoted.
 *
 * SCOPE — measurement integrity only. Nothing here reads, alters, or is consulted by any HAL decision,
 * threshold, veto, or quorum gate. It classifies data that has already been written.
 *
 * RELATIONSHIP TO `measurement-integrity.ts`: that module's `observedFamilyWidth()` counts families
 * from in-process `ProviderAttempt` objects, which carry a typed `family` field. This module handles
 * the PERSISTED shape — an untyped `unknown` off a DB row, where the family field never existed. The
 * two do not overlap; this one is the guard for data that has already lost its structure.
 *
 * PURITY: no I/O, no env reads, no DB, no network.
 */
import { ConfigurationWidth, HalStrictness } from './measurement-ruler';

/**
 * Provider labels that are TRANSPORTS, not model families.
 *
 * A gateway multiplexes many families behind one name, so its presence means the family width was not
 * recorded — it is unknown, not one. Kept deliberately small and literal: only names actually observed
 * acting as a gateway in this system, so the check never guesses about an unfamiliar label.
 */
export const GATEWAY_PROVIDER_LABELS: ReadonlySet<string> = new Set([
  'litellm',
  'openrouter',
  'portkey',
]);

/** How a persisted provider list fails to describe a family width. */
export type ProviderListFaultKind =
  /** Not an array at all (NULL, a bare string, an object). */
  | 'not-an-array'
  /** Array with zero elements — no provider recorded, so width is unknown, not 0. */
  | 'empty-list'
  /** An element is not a string. */
  | 'non-string-element'
  /** An element is blank/whitespace. */
  | 'blank-element'
  /** An element is a COUNT masquerading as a name (`used:2`, or a bare number). THE live corruption. */
  | 'count-smuggled-as-name'
  /** An element names a gateway/transport, so the family behind it was never recorded. */
  | 'gateway-not-a-family'
  /** The same provider appears twice — width would double-count one family. */
  | 'duplicate-provider';

/** One specific reason a provider list cannot yield a family width. */
export interface ProviderListFault {
  kind: ProviderListFaultKind;
  /** The offending element, when the fault is attributable to one. */
  element?: string;
  detail: string;
}

/** Matches the live corruption: `used:2`, and the bare-count variant it would degrade into. */
const COUNT_SMUGGLED = /^\s*(?:used\s*[:=]\s*)?\d+\s*$/i;

/**
 * Thrown instead of returning a width derived from a corrupt provider list.
 *
 * The message leads with the refusal and names the corruption, because a width that is merely wrong is
 * indistinguishable from a width that is right — there is no downstream check that would catch it.
 */
export class MalformedProviderListError extends Error {
  readonly faults: ProviderListFault[];
  readonly raw: unknown;
  constructor(faults: ProviderListFault[], raw: unknown, context?: string) {
    super(
      `[hal-provider-width] refusing to compute a family width from a malformed provider list` +
        (context ? ` (${context})` : '') +
        `. Faults: ${faults.map((f) => `[${f.kind}] ${f.detail}`).join('; ')}. ` +
        `Raw value: ${safeRender(raw)}. ` +
        `This list is provider NAMES; a count written into it (e.g. "used:2") understates width — ` +
        `{"used:2"} has array_length 1 while the run reached 2 families. ` +
        `The width is UNKNOWN, and an unknown width is not a zero and not a one.`,
    );
    this.name = 'MalformedProviderListError';
    this.faults = faults;
    this.raw = raw;
  }
}

/** Thrown when a per-case width range is collapsed into a single run-level width. */
export class WidthCollapseError extends Error {
  constructor(reason: string) {
    super(`[hal-provider-width] refusing to report a run-level width: ${reason}`);
    this.name = 'WidthCollapseError';
  }
}

function safeRender(raw: unknown): string {
  try {
    const s = JSON.stringify(raw);
    return s === undefined ? String(raw) : s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(raw);
  }
}

/**
 * Enumerate every reason a persisted provider list cannot yield a family width. Empty list = usable.
 *
 * Returns ALL faults rather than the first, so a caller reporting a corrupt run sees the whole shape of
 * the corruption in one pass instead of fixing one row and re-running.
 */
export function providerListFaults(raw: unknown): ProviderListFault[] {
  if (!Array.isArray(raw)) {
    return [
      {
        kind: 'not-an-array',
        detail:
          raw === null || raw === undefined
            ? `provider list is ${String(raw)} — no providers were recorded, so the family width is unknown (NOT zero)`
            : `provider list is ${typeof raw}, expected an array of provider names`,
      },
    ];
  }

  if (raw.length === 0) {
    return [
      {
        kind: 'empty-list',
        detail:
          `provider list is empty — zero providers recorded. The width is UNKNOWN, not 0: an empty list ` +
          `cannot distinguish "no provider answered" (an environment fault) from "the list was never written".`,
      },
    ];
  }

  const faults: ProviderListFault[] = [];
  const seen = new Set<string>();

  for (const el of raw) {
    if (typeof el !== 'string') {
      faults.push({
        kind: 'non-string-element',
        detail: `element ${safeRender(el)} is ${typeof el}, not a provider name`,
      });
      continue;
    }
    const trimmed = el.trim();
    if (trimmed === '') {
      faults.push({ kind: 'blank-element', element: el, detail: 'element is blank' });
      continue;
    }
    if (COUNT_SMUGGLED.test(trimmed)) {
      faults.push({
        kind: 'count-smuggled-as-name',
        element: el,
        detail:
          `element ${JSON.stringify(el)} is a COUNT, not a provider name — a writer put the number of ` +
          `providers into the name array. The real width is not recoverable from array length.`,
      });
      continue;
    }
    const key = trimmed.toLowerCase();
    if (GATEWAY_PROVIDER_LABELS.has(key)) {
      faults.push({
        kind: 'gateway-not-a-family',
        element: el,
        detail:
          `${JSON.stringify(el)} is a GATEWAY, not a model family — it fronts many families behind one ` +
          `name, so the family width behind it was never recorded. Counting it as one family would ` +
          `overstate the independence of the quorum.`,
      });
      continue;
    }
    if (seen.has(key)) {
      faults.push({
        kind: 'duplicate-provider',
        element: el,
        detail: `${JSON.stringify(el)} appears more than once — counting it twice would inflate the width`,
      });
      continue;
    }
    seen.add(key);
  }

  return faults;
}

/** A provider list that is safe to count, or the reasons it is not. */
export type ProviderListVerdict =
  | { usable: true; providers: string[]; width: number }
  | { usable: false; faults: ProviderListFault[] };

/**
 * Classify a persisted provider list without throwing. Use when auditing many rows, where the goal is
 * to report how much of a column is corrupt rather than to stop at the first bad row.
 */
export function inspectProviderList(raw: unknown): ProviderListVerdict {
  const faults = providerListFaults(raw);
  if (faults.length > 0) return { usable: false, faults };
  const providers = (raw as string[]).map((s) => s.trim());
  return { usable: true, providers, width: new Set(providers.map((p) => p.toLowerCase())).size };
}

/** Throw unless the list is a countable set of distinct, real provider names. */
export function assertProviderList(raw: unknown, context?: string): asserts raw is string[] {
  const faults = providerListFaults(raw);
  if (faults.length > 0) throw new MalformedProviderListError(faults, raw, context);
}

/**
 * THE GATE between a persisted provider list and a family width.
 *
 * Throws `MalformedProviderListError` rather than returning a number, on every corrupt shape. There is
 * deliberately no `{ fallback }` option and no lenient mode: a caller that wants a number badly enough
 * to pass a default is the exact caller that would go on to quote it.
 */
export function caseWidthFromProviderList(raw: unknown, context?: string): number {
  const verdict = inspectProviderList(raw);
  if (!verdict.usable) throw new MalformedProviderListError(verdict.faults, raw, context);
  return verdict.width;
}

/** Per-case widths observed across a run, with the corrupt cases kept separate rather than folded in. */
export interface CaseWidthCensus {
  /** Distinct-family width for each case that had a usable provider list. */
  usableWidths: number[];
  /** Cases whose provider list was refused, with the reason. Never counted as width 0. */
  refused: { index: number; faults: ProviderListFault[] }[];
  /** Total cases examined. */
  total: number;
}

/**
 * Take a census of per-case provider lists. Corrupt cases land in `refused` and are NEVER silently
 * treated as width 0 — that coercion is what let 1419 empty lists read as a legitimate observation.
 */
export function censusCaseWidths(rawLists: readonly unknown[]): CaseWidthCensus {
  const usableWidths: number[] = [];
  const refused: { index: number; faults: ProviderListFault[] }[] = [];
  rawLists.forEach((raw, index) => {
    const verdict = inspectProviderList(raw);
    if (verdict.usable) usableWidths.push(verdict.width);
    else refused.push({ index, faults: verdict.faults });
  });
  return { usableWidths, refused, total: rawLists.length };
}

/**
 * Describe a per-case width distribution as the run-level range it actually is.
 *
 * This is the anti-collapse function. The live run `ga-internal-2026-06-09T04-05-38-350Z` judged
 * **312 cases with 1 family, 11 with 2, and 1 with 3** — verified independently on 2026-08-03. Reported
 * as "3 families" (the max) it flatters the run; as a mean of ~1.04 it invents a fractional family that
 * no case ever saw. Both are single scalars, and a single scalar is the lie. The honest report is the
 * range plus the fact that it is a range.
 */
export function summarizeCaseWidths(census: CaseWidthCensus): {
  min: number;
  max: number;
  uniform: boolean;
  histogram: { width: number; cases: number }[];
  refusedCount: number;
  description: string;
} {
  const { usableWidths, refused, total } = census;
  if (usableWidths.length === 0) {
    return {
      min: 0,
      max: 0,
      uniform: false,
      histogram: [],
      refusedCount: refused.length,
      description:
        `no case in this run had a usable provider list (${refused.length}/${total} refused) — ` +
        `the run's family width is UNKNOWN`,
    };
  }
  const counts = new Map<number, number>();
  for (const w of usableWidths) counts.set(w, (counts.get(w) ?? 0) + 1);
  const histogram = [...counts.entries()]
    .map(([width, cases]) => ({ width, cases }))
    .sort((a, b) => a.width - b.width);
  const min = Math.min(...usableWidths);
  const max = Math.max(...usableWidths);
  const uniform = min === max && refused.length === 0;
  const shape = histogram.map((h) => `${h.cases}@${h.width}`).join(', ');
  const refusedNote = refused.length ? `; ${refused.length}/${total} cases REFUSED (corrupt list)` : '';
  return {
    min,
    max,
    uniform,
    histogram,
    refusedCount: refused.length,
    description: uniform
      ? `all ${usableWidths.length} cases judged at ${max} families`
      : `NON-UNIFORM width across cases (${shape})${refusedNote} — the run has a width RANGE ${min}-${max}, not a single width`,
  };
}

/**
 * Why a per-case width distribution may not be reported as one run-level number, or `null` if it may.
 *
 * Non-null on any of: a refused case (unknown width cannot be averaged away), or a genuine spread
 * between the narrowest and widest case.
 */
export function widthCollapseFault(census: CaseWidthCensus): string | null {
  const s = summarizeCaseWidths(census);
  if (census.usableWidths.length === 0) return s.description;
  if (s.refusedCount > 0) {
    return (
      `${s.refusedCount} of ${census.total} cases had a provider list that could not be counted, so the ` +
      `run-level width is unknown — a refused case is not a case at width 0`
    );
  }
  if (!s.uniform) return s.description;
  return null;
}

/** Throw unless every case in the run was judged at the same, known family width. */
export function assertUniformCaseWidth(census: CaseWidthCensus, context?: string): void {
  const fault = widthCollapseFault(census);
  if (fault) throw new WidthCollapseError(`${fault}${context ? ` (${context})` : ''}`);
}

/**
 * Build the `ConfigurationWidth` half of a ruler from a per-case census.
 *
 * `familiesMin`/`familiesMax` come from what the run ACHIEVED per case, so a collapse is preserved in
 * the ruler rather than smoothed out of it — `describeWidth()` then renders it as `1-3 families
 * (observed) [DEGRADED: configured 3]`, and `assessRunIntegrity()` blocks the measurement because
 * `familiesMin < familiesConfigured`. That is the intended path: the collapse survives all the way to
 * the refusal.
 *
 * Refuses outright when any case's list was corrupt, because an unknown per-case width cannot honestly
 * populate a minimum.
 */
export function configurationWidthFromCensus(args: {
  census: CaseWidthCensus;
  familiesConfigured: number;
  strictness: HalStrictness;
  decisionRequiresQuorum: boolean;
  penaltyRequiresQuorum: boolean;
  context?: string;
}): ConfigurationWidth {
  const { census, familiesConfigured, strictness, decisionRequiresQuorum, penaltyRequiresQuorum } = args;
  if (census.usableWidths.length === 0) {
    throw new WidthCollapseError(
      `no case had a usable provider list (${census.refused.length}/${census.total} refused)` +
        `${args.context ? ` (${args.context})` : ''} — cannot populate familiesMin/familiesMax`,
    );
  }
  if (census.refused.length > 0) {
    throw new WidthCollapseError(
      `${census.refused.length} of ${census.total} cases had an uncountable provider list` +
        `${args.context ? ` (${args.context})` : ''} — familiesMin would be a guess. ` +
        `First fault: [${census.refused[0]!.faults[0]!.kind}] ${census.refused[0]!.faults[0]!.detail}`,
    );
  }
  return {
    familiesConfigured,
    familiesMin: Math.min(...census.usableWidths),
    familiesMax: Math.max(...census.usableWidths),
    strictness,
    decisionRequiresQuorum,
    penaltyRequiresQuorum,
  };
}
