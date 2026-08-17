/**
 * reskin.ts — truth-preserving surface transformations, for measuring whether HAL is judging the
 * CLAIM or the WRITING.
 *
 * TERMINOLOGY: "re-skin invariance" is from the OmegaHive test-qualification paper (Goertzel,
 * *Seeding RSI Toward ASI*, 2026-08-07): re-render a problem in a way that cannot change the
 * answer, and check the answer does not change. If it does, the system was pattern-matching the
 * surface. See docs/RSI-ADOPTION-PLAN.md §3.4 — this is the one Phase 2 item that needs no live
 * fleet and no provider keys, because the transformations and the strictness-1 extractor are both
 * pure.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE TRANSFORMS ARE MECHANICAL AND NOT LLM-GENERATED
 * ════════════════════════════════════════════════════════════════════════════════
 * The obvious way to build this is to ask a model for paraphrases. That destroys the measurement.
 * If a paraphrase is model-written, a changed verdict is ambiguous between "HAL is surface
 * sensitive" (the finding) and "the paraphrase changed the meaning" (an artifact), and there is no
 * way to tell which from the output. The whole value of the probe is that the null hypothesis is
 * airtight: these transformations CANNOT change whether the claim is true, so any movement is
 * attributable to the instrument.
 *
 * So every transform here is deterministic, mechanical, and carries a written justification for
 * why it is truth-preserving. A transform that cannot be justified in one sentence does not belong
 * in this file.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * TRUTH-PRESERVING IS NOT THE SAME AS SIGNAL-NEUTRAL
 * ════════════════════════════════════════════════════════════════════════════════
 * A distinction worth stating, because it is the one place this probe could be argued with.
 *
 * HAL's signals deliberately measure STYLE as a proxy for hallucination risk — overconfidence
 * markers, hedge density, text length. So a transform that changes style is not automatically
 * measuring a defect: an extractor that scores "definitely X" differently from "X" is doing what it
 * was built to do.
 *
 * The transforms below are therefore restricted to changes that alter **no stylistic property HAL
 * claims to measure**: punctuation rendering, number rendering, capitalisation, and contentless
 * padding. None of them adds or removes a hedge, an overconfidence marker, or a factual assertion.
 * Movement under these is not a defensible design choice; it is the instrument reading the
 * typography.
 *
 * `contentless-prefix` is the one that deserves scrutiny, and it is included precisely because it
 * probes `lengthScore = min(1, wordCount/40)` — a term under which padding a claim with words that
 * assert nothing RAISES its measured evidence quality. It is paired with `initial-lowercase` so the
 * length effect can be separated from the capitalisation effect it necessarily also introduces:
 * `contentless-prefix` = `initial-lowercase` + five contentless words, so the difference between
 * the two isolates the length term. That is the paper's factorial idea in miniature.
 *
 * PURITY: no I/O, no env reads, no clock. Every transform is a pure string function.
 */

/** One truth-preserving surface transformation. */
export interface ReskinTransform {
  /** Stable id — appears in results, so it must not drift. */
  readonly id: string;
  /** What it does to the string. */
  readonly description: string;
  /** Why it cannot change whether the claim is true. Required; see the header. */
  readonly justification: string;
  /** Which extractor term it is aimed at, for reading the results. */
  readonly probes: string;
  readonly apply: (text: string) => string;
}

/** Lowercase only the first character, leaving the rest untouched. */
function lowerInitial(text: string): string {
  if (text.length === 0) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The transform set. Ordered so a reader meets the negative control first and the strongest probe
 * last.
 *
 * Version this list when it changes: results taken under different transform sets are not
 * comparable, the same way two F1 numbers under different rulers are not (LESSONS §8).
 */
export const RESKIN_TRANSFORM_SET_VERSION = 'reskin-v1';

export const RESKIN_TRANSFORMS: readonly ReskinTransform[] = [
  {
    id: 'identity',
    description: 'returns the text unchanged',
    justification:
      'a no-op cannot change anything; this is the NEGATIVE CONTROL. If the harness reports any ' +
      'movement here, the harness is broken and every other row is untrustworthy.',
    probes: 'the harness itself',
    apply: (t) => t,
  },
  {
    id: 'terminal-period',
    description: 'adds a trailing full stop, or removes it if already present',
    justification:
      'terminal punctuation carries no propositional content; "X." and "X" assert the same thing.',
    probes: 'token-boundary sensitivity in substring marker matching',
    apply: (t) => {
      const trimmed = t.trimEnd();
      return trimmed.endsWith('.') ? trimmed.slice(0, -1) : `${trimmed}.`;
    },
  },
  {
    id: 'typographic-punctuation',
    description: 'ASCII apostrophes, quotes and hyphens rendered as typographic equivalents',
    justification:
      "’ and ' are the same apostrophe; a renderer choice cannot change a fact.",
    probes: 'substring matching of multi-word markers containing punctuation',
    apply: (t) =>
      t
        .replace(/'/g, '’')
        .replace(/"([^"]*)"/g, '“$1”')
        .replace(/ - /g, ' – '),
  },
  {
    id: 'percent-to-word',
    description: 'renders "5%" as "5 percent" (and back, if already spelled out)',
    justification:
      '"%" and "percent" are two spellings of one quantity. The claim is numerically identical.',
    probes: 'the specific-numbers regex in harm_probability, and wordCount',
    // GUARD: `'100%'` is a LITERAL entry in OVERCONFIDENCE_MARKERS (src/hal/lib/constants.ts), and
    // markers are matched by substring. So rewriting "100%" to "100 percent" would DELETE an
    // overconfidence marker, and the reverse would CREATE one — either way the transform would be
    // changing a stylistic property HAL claims to measure, which is exactly what this file's header
    // forbids. Such a text is left alone rather than silently re-skinned into a different claim
    // about confidence. Found by writing the marker-neutrality test, not by reading the list.
    apply: (t) => {
      if (t.includes('100%') || /100\s+percent/i.test(t)) return t;
      return /\d\s*%/.test(t)
        ? t.replace(/(\d)\s*%/g, '$1 percent')
        : t.replace(/(\d)\s+percent\b/g, '$1%');
    },
  },
  {
    id: 'digit-grouping',
    description: 'removes thousands separators from numerals ("1,000" becomes "1000")',
    justification:
      'digit grouping is a display convention; 1,000 and 1000 are the same number.',
    probes: 'the numeric regexes in harm_probability and evidence_quality',
    apply: (t) => t.replace(/(\d),(?=\d{3}\b)/g, '$1'),
  },
  {
    id: 'initial-lowercase',
    description: 'lowercases the first character only',
    justification:
      'sentence-initial capitalisation is orthographic, not semantic. Paired with ' +
      'contentless-prefix to separate the capitalisation effect from the length effect.',
    probes: 'hasProperNouns, which reads the ORIGINAL case while every other signal reads lowercase',
    apply: lowerInitial,
  },
  {
    id: 'full-lowercase',
    description: 'lowercases the entire claim',
    justification:
      'case is orthographic. "the great wall of china is visible from space" asserts exactly what ' +
      'the capitalised rendering asserts, and is equally false.',
    probes: 'hasProperNouns at full strength',
    apply: (t) => t.toLowerCase(),
  },
  {
    id: 'contentless-prefix',
    description: 'prepends "It is the case that " and lowercases the original initial',
    justification:
      '"It is the case that X" and "X" assert the same proposition. The five added words contain ' +
      'no hedge, no overconfidence marker, and no factual content — they are pure padding.',
    probes: 'lengthScore = min(1, wordCount/40) inside evidence_quality',
    apply: (t) => `It is the case that ${lowerInitial(t)}`,
  },
];

/** Result of applying one transform. `changed` is false when the transform was a no-op on this input. */
export interface ReskinApplication {
  transformId: string;
  original: string;
  reskinned: string;
  /** false when the transform did not apply to this string (nothing to change). */
  changed: boolean;
}

export function applyReskin(transform: ReskinTransform, text: string): ReskinApplication {
  const reskinned = transform.apply(text);
  return {
    transformId: transform.id,
    original: text,
    reskinned,
    changed: reskinned !== text,
  };
}

/** Look a transform up by id. Returns undefined rather than throwing; callers decide. */
export function transformById(id: string): ReskinTransform | undefined {
  return RESKIN_TRANSFORMS.find((t) => t.id === id);
}
