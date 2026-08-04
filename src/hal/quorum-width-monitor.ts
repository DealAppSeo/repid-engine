/**
 * quorum-width-monitor.ts — HAL's central claim is cross-examination across INDEPENDENT
 * model families. Nothing in production checks how many actually answered.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GAP, AND HOW IT WAS FOUND
 * ════════════════════════════════════════════════════════════════════════════════
 * `tests/hal/golden-math.test.ts` already does this properly — and only for the TEST.
 * It refuses to report a quality number when the fleet answers on fewer families than
 * the frozen claim was measured at, and it says so in those words: *"PROVIDER FLEET
 * DEGRADED, NOT A QUALITY REGRESSION."* That is the correct behaviour and it protects
 * a corpus run.
 *
 * Production has no equivalent. Live quorum width is recorded — `pipeline.ts`
 * (`halClassificationModelLabel`) writes it into `hal_classifications.model` as
 * `fact-check-quorum:llama+glm+gemini+mistral+qwen` — and then nothing ever reads it
 * back to ask whether the number is holding.
 *
 * It is not holding. Observed 2026-08-04 over the preceding week:
 *
 *     2026-08-02   llama+glm+gemini+mistral+qwen   5 families
 *     2026-08-01   llama+glm+gemini+mistral        4
 *     2026-08-03   llama+glm+mistral               3   (gemini absent)
 *     2026-08-04   llama+gemini+mistral            3   (glm absent)
 *
 * Families are dropping in and out, the width has fallen from 5 to 3, and no surface
 * said a word. It was found by querying, which is exactly the failure mode this file
 * exists to end.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS MATTERS MORE THAN A TYPICAL METRIC
 * ════════════════════════════════════════════════════════════════════════════════
 * A veto from four families that agree is a different epistemic object from a veto by
 * two. Both look identical downstream: same `hal_decision`, same RepID delta, same
 * receipt. The width is the only thing that distinguishes independent corroboration
 * from a narrow quorum that happened to agree — and a narrower quorum agreeing is
 * precisely what coordinated dissonance looks like (CANON P-003).
 *
 * So a HAL number without its width is a measurement without its ruler
 * (CLAUDE_RULES 24), and this module makes the width legible.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * READ-ONLY, AND IT NEVER JUDGES QUALITY
 * ════════════════════════════════════════════════════════════════════════════════
 * No writes, no route, no HAL behaviour change. It reports WIDTH, never accuracy — the
 * whole point is to keep those two separable, so a provider outage can never again be
 * read as a scoring problem, and a scoring problem can never hide behind an outage.
 */

/**
 * Families the frozen HAL claims were measured at.
 *
 * Deliberately a declared constant rather than "the maximum ever seen": a high-water
 * mark silently redefines the baseline every time a lucky run adds a family, which
 * makes degradation invisible by construction — the ratchet running the wrong way.
 */
export const DECLARED_QUORUM_WIDTH = 5;

/** Below this a quorum is not meaningfully a quorum; it is a second opinion. */
export const MINIMUM_MEANINGFUL_WIDTH = 2;

export type WidthVerdict =
  /** At or above the width the frozen claims were measured at. */
  | 'AT_DECLARED_WIDTH'
  /** Narrower than declared but still a real quorum. Results are about a different config. */
  | 'DEGRADED'
  /** One or zero families. Nothing here is cross-examination. */
  | 'NOT_A_QUORUM'
  /** The run did not reach the quorum path at all — extractor, fallback, or error. */
  | 'NO_QUORUM_PATH'
  /** The label exists but its width cannot be read. Never guessed at. */
  | 'UNREADABLE';

export interface WidthReading {
  label: string;
  families: string[];
  width: number | null;
  verdict: WidthVerdict;
  /** True only at the declared width — every quality claim must gate on this. */
  comparableToFrozenClaims: boolean;
  reason: string;
}

const QUORUM_PREFIX = 'fact-check-quorum';

/**
 * Read the width out of a `hal_classifications.model` label.
 *
 * The grammar is fixed by `halClassificationModelLabel` in `scoring/pipeline.ts`:
 *   `fact-check-quorum:llama+glm+gemini`  — quorum met, families known
 *   `fact-check-quorum`                   — quorum met, families NOT recorded
 *   `fact-check-partial`                  — fact-check ran, no quorum formed
 *   `extractor-fallback` / `deterministic-extractor` / `hal-error-fallback`
 *
 * The bare `fact-check-quorum` case is the subtle one. It means a quorum was met and
 * the family list was lost, so the width is UNKNOWN — not zero, and not the declared
 * width. Treating an unrecorded list as either would be inventing a measurement.
 */
export function readQuorumWidth(
  label: string | null | undefined,
  declared: number = DECLARED_QUORUM_WIDTH,
): WidthReading {
  const raw = (label ?? '').trim();

  if (!raw.startsWith(QUORUM_PREFIX)) {
    return {
      label: raw,
      families: [],
      width: null,
      verdict: 'NO_QUORUM_PATH',
      comparableToFrozenClaims: false,
      reason: raw
        ? `label "${raw}" is not a quorum path — no cross-family examination happened`
        : 'no label recorded',
    };
  }

  const sep = raw.indexOf(':');
  if (sep === -1) {
    return {
      label: raw,
      families: [],
      width: null,
      verdict: 'UNREADABLE',
      comparableToFrozenClaims: false,
      reason:
        'a quorum was met but the family list was not recorded, so the width is unknown — ' +
        'not zero, and not the declared width; both would be inventing a measurement',
    };
  }

  const families = raw
    .slice(sep + 1)
    .split('+')
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);

  // Duplicates are not independence. Two routes to the same family is one family, and
  // counting the transport would overstate exactly the property being claimed.
  const unique = [...new Set(families)];
  const width = unique.length;

  if (width === 0) {
    return {
      label: raw,
      families: [],
      width: null,
      verdict: 'UNREADABLE',
      comparableToFrozenClaims: false,
      reason: 'quorum label carried an empty family list',
    };
  }

  if (width < MINIMUM_MEANINGFUL_WIDTH) {
    return {
      label: raw,
      families: unique,
      width,
      verdict: 'NOT_A_QUORUM',
      comparableToFrozenClaims: false,
      reason: `${width} family answered — a single voice is a second opinion, not cross-examination`,
    };
  }

  if (width < declared) {
    return {
      label: raw,
      families: unique,
      width,
      verdict: 'DEGRADED',
      comparableToFrozenClaims: false,
      reason:
        `${width} of ${declared} families answered. This is a real quorum, but the frozen HAL ` +
        `claims were measured at ${declared}, so a result here describes a DIFFERENT ` +
        `configuration and can neither confirm nor refute them`,
    };
  }

  return {
    label: raw,
    families: unique,
    width,
    verdict: 'AT_DECLARED_WIDTH',
    comparableToFrozenClaims: true,
    reason: `${width} independent families answered — comparable to the frozen claims`,
  };
}

export interface WidthWindow {
  /** Row shape needed: the label and when it was written. */
  label: string | null | undefined;
  at?: string | null;
}

export interface WidthSummary {
  examined: number;
  byVerdict: Record<WidthVerdict, number>;
  /** Runs comparable to the frozen claims. Any accuracy statement must cite THIS. */
  comparable: number;
  narrowest: number | null;
  widest: number | null;
  /** Families seen at least once, and those absent from the widest run. */
  familiesSeen: string[];
  /** A sentence an operator or a reviewer can act on. */
  headline: string;
}

export function summariseWidth(
  rows: readonly WidthWindow[],
  declared: number = DECLARED_QUORUM_WIDTH,
): WidthSummary {
  const byVerdict: Record<WidthVerdict, number> = {
    AT_DECLARED_WIDTH: 0,
    DEGRADED: 0,
    NOT_A_QUORUM: 0,
    NO_QUORUM_PATH: 0,
    UNREADABLE: 0,
  };
  const seen = new Set<string>();
  let narrowest: number | null = null;
  let widest: number | null = null;
  let comparable = 0;

  for (const r of rows) {
    const w = readQuorumWidth(r.label, declared);
    byVerdict[w.verdict]++;
    if (w.comparableToFrozenClaims) comparable++;
    for (const f of w.families) seen.add(f);
    if (w.width !== null) {
      narrowest = narrowest === null ? w.width : Math.min(narrowest, w.width);
      widest = widest === null ? w.width : Math.max(widest, w.width);
    }
  }

  const degraded = byVerdict.DEGRADED + byVerdict.NOT_A_QUORUM;
  const headline =
    rows.length === 0
      ? 'No HAL quorum runs in this window — width cannot be assessed, and absence is not health.'
      : comparable === 0 && degraded > 0
        ? `NO run in this window reached the declared width of ${declared}. Narrowest ${narrowest}, ` +
          `widest ${widest}. Every HAL number from this window describes a narrower ` +
          `configuration than the frozen claims and must not be compared to them.`
        : degraded > 0
          ? `${comparable} run(s) at the declared width of ${declared}, ${degraded} narrower ` +
            `(narrowest ${narrowest}). The fleet is losing families intermittently.`
          : `All ${comparable} run(s) at the declared width of ${declared}.`;

  return {
    examined: rows.length,
    byVerdict,
    comparable,
    narrowest,
    widest,
    familiesSeen: [...seen].sort(),
    headline,
  };
}

/** Which declared families were missing from a run. Names the outage, not just the count. */
export function missingFamilies(reading: WidthReading, expected: readonly string[]): string[] {
  const present = new Set(reading.families);
  return expected.map((f) => f.toLowerCase()).filter((f) => !present.has(f));
}

export function formatWidth(s: WidthSummary): string {
  return [
    `[hal-quorum-width] ${s.examined} run(s) examined, declared width ${DECLARED_QUORUM_WIDTH}`,
    `  at declared width : ${s.byVerdict.AT_DECLARED_WIDTH}   <- only these are comparable to frozen claims`,
    `  degraded          : ${s.byVerdict.DEGRADED}`,
    `  not a quorum      : ${s.byVerdict.NOT_A_QUORUM}`,
    `  no quorum path    : ${s.byVerdict.NO_QUORUM_PATH}`,
    `  unreadable width  : ${s.byVerdict.UNREADABLE}`,
    `  families seen     : ${s.familiesSeen.join(', ') || '(none)'}`,
    `  ${s.headline}`,
  ].join('\n');
}
