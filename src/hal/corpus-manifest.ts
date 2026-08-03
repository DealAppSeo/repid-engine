/**
 * HAL CORPUS MANIFEST — the ruler an accuracy number is taken with.
 * OUTPUT_PATH: src/hal/corpus-manifest.ts
 *
 * THE PROBLEM THIS EXISTS TO KILL
 * -------------------------------
 * HAL's F1 has been quoted at 0.34, 0.74, 0.886 and 0.890. Those are not a trend — they are four
 * different RULERS. The evidence, verified against the live database on 2026-08-03:
 *
 *   - `hal_test_cases` grew 109 -> 1000 -> 2517 cases between 2026-05-28 and 2026-06-18. A run
 *     "over the corpus" in May and one in July measured different populations under one name.
 *   - `hal_validation_summaries` stores `f1_score` next to exactly ONE descriptor of how the run was
 *     configured: `harness_version`. Every row in it reads `1.0.0` (or a hand-typed variant). Two
 *     runs on 2026-07-04 recorded F1 0.344 and F1 0.798 over the SAME 1000 case ids, both stamped
 *     `harness_version = '1.0.0'`. The stored metadata cannot tell them apart. The difference was
 *     configuration, and configuration was never written down.
 *   - `hal_test_cases` holds 2517 rows but `hal_test_cases_distinct` holds 2342 — ~175 duplicate
 *     cases. An unordered, un-deduplicated "the corpus" is not one population.
 *
 * So the fix is not a better model or a better threshold. It is that a measurement must carry the
 * ruler it was taken with, or it is not a measurement. This module builds that ruler; the refusal
 * that enforces it lives in ./measurement-ruler.
 *
 * WHAT MAKES A CORPUS IDENTITY
 * ----------------------------
 * A stable id (what we call it) + a content hash (what it actually was) + a case count. The id alone
 * is a promise; the hash is the receipt. `corpus v1` means nothing across two months — `corpus
 * v1@sha256:2f9c…` means exactly one population of cases forever.
 *
 * THE HASH IS ORDER-SENSITIVE, AND THAT IS DELIBERATE. Reordering a corpus changes evaluation under
 * any early-stopping, sampling, budget-capped or partially-completed run, so two orderings are two
 * rulers. Callers that genuinely do not care about order sort their cases before hashing (see
 * `sortCasesById`) and thereby commit to the sorted order as the canonical one.
 *
 * PURITY: no I/O, no env reads, no DB. Hashing a case set must be reproducible from the case set
 * alone — anything else and the hash stops being a receipt.
 */
import { createHash } from 'crypto';

/** Algorithm label embedded in every emitted hash so a future change is self-describing. */
export const CORPUS_HASH_ALGORITHM = 'sha256';

/** Chars of hex shown in human-readable ruler strings. Full hash is always retained on the manifest. */
export const CORPUS_HASH_DISPLAY_LEN = 12;

/**
 * One labeled evaluation case, reduced to the fields that DEFINE it.
 *
 * Only these fields enter the hash. Everything else about a case (its notes, difficulty, when it was
 * created, which agent proposed it) is metadata that must be free to change without minting a new
 * corpus identity — otherwise the hash churns for reasons unrelated to what is being measured.
 */
export interface CorpusCase {
  /** Stable per-case identifier, unique within the corpus. */
  id: string;
  /** The text HAL judges. */
  text: string;
  /** Gold label: true = hallucination / REFUTED (the positive class). */
  expectedHallucination: boolean;
  /** Optional grounding context supplied to the fact-check prompt; part of the case if present. */
  context?: string;
}

/** A provenance pointer: where some slice of the corpus came from. Recorded, never hashed. */
export interface CorpusSourceRef {
  /** e.g. 'hal_test_cases', 'halueval-jsonl', 'external-fever-20260608-n300'. */
  source: string;
  /** How many cases this source contributed. */
  caseCount: number;
  /** Optional free-text note (a file path, a dataset version, a query). */
  note?: string;
}

/** A frozen corpus identity. Cheap to pass around, safe to persist, meaningful forever. */
export interface CorpusManifest {
  /** Stable human-chosen id, e.g. 'hal-halueval-fever-v1'. */
  corpusId: string;
  /** `sha256:<64 hex>` over the ordered, canonicalized case set. */
  contentHash: string;
  /** Number of cases in the hashed set. */
  caseCount: number;
  /** How many of the cases carry the positive (hallucination) label. */
  positiveCount: number;
  /** ISO timestamp the manifest was built. Metadata — NOT part of the hash. */
  builtAt: string;
  /** Where the cases came from. Metadata — NOT part of the hash. */
  sources: CorpusSourceRef[];
}

/** Thrown when a case set cannot be given a trustworthy identity. */
export class InvalidCorpusError extends Error {
  constructor(message: string) {
    super(`[hal-corpus] ${message}`);
    this.name = 'InvalidCorpusError';
  }
}

/**
 * Canonical serialization of ONE case.
 *
 * Field order is fixed here and must never be reordered — doing so would silently invalidate every
 * previously published hash. Lengths are prefixed so that no combination of field contents can be
 * rearranged into a different case set with the same bytes (`text:"ab", context:"c"` and
 * `text:"a", context:"bc"` must not collide).
 */
function canonicalizeCase(c: CorpusCase): string {
  const parts = [
    `id:${c.id.length}:${c.id}`,
    `text:${c.text.length}:${c.text}`,
    `expected:${c.expectedHallucination ? 1 : 0}`,
    c.context === undefined ? 'context:-' : `context:${c.context.length}:${c.context}`,
  ];
  return parts.join('|');
}

/**
 * Hash an ORDERED case set. Order-sensitive by design (see module header).
 *
 * Refuses an empty set and refuses duplicate ids: both produce a hash that looks authoritative while
 * describing a population nobody can reconstruct. The live `hal_test_cases` table currently holds
 * ~175 duplicate cases, so the duplicate check is a real guard, not a theoretical one.
 */
export function computeCorpusHash(cases: readonly CorpusCase[]): string {
  if (cases.length === 0) {
    throw new InvalidCorpusError('refusing to hash an empty case set — there is nothing to measure');
  }
  const seen = new Set<string>();
  const h = createHash(CORPUS_HASH_ALGORITHM);
  for (const c of cases) {
    if (!c.id) throw new InvalidCorpusError('every case needs a non-empty id to be identifiable');
    if (seen.has(c.id)) {
      throw new InvalidCorpusError(
        `duplicate case id ${JSON.stringify(c.id)} — a corpus with duplicates is not one population; ` +
          `de-duplicate before hashing (see hal_test_cases vs hal_test_cases_distinct)`,
      );
    }
    seen.add(c.id);
    h.update(canonicalizeCase(c));
    h.update('\n');
  }
  return `${CORPUS_HASH_ALGORITHM}:${h.digest('hex')}`;
}

/**
 * Deterministic ordering helper for callers whose case order is incidental (a DB query without an
 * ORDER BY, a directory walk). Sorting then hashing commits to the sorted order as canonical, which
 * is the honest way to say "order does not matter for this corpus".
 */
export function sortCasesById(cases: readonly CorpusCase[]): CorpusCase[] {
  return [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Build a frozen manifest for a case set. This is the only sanctioned way to mint a corpus identity. */
export function buildCorpusManifest(args: {
  corpusId: string;
  cases: readonly CorpusCase[];
  sources?: CorpusSourceRef[];
  /** Injectable for deterministic tests. Defaults to now. */
  builtAt?: Date;
}): CorpusManifest {
  const corpusId = args.corpusId?.trim();
  if (!corpusId) {
    throw new InvalidCorpusError(
      'corpusId is required — an unnamed corpus cannot be cited, compared, or re-run',
    );
  }
  const contentHash = computeCorpusHash(args.cases);
  return {
    corpusId,
    contentHash,
    caseCount: args.cases.length,
    positiveCount: args.cases.reduce((n, c) => n + (c.expectedHallucination ? 1 : 0), 0),
    builtAt: (args.builtAt ?? new Date()).toISOString(),
    sources: args.sources ?? [],
  };
}

/** Short form of a hash for human-readable strings. Full hash stays on the manifest. */
export function shortHash(contentHash: string): string {
  const [algo, hex] = contentHash.split(':');
  if (!hex) return contentHash;
  return `${algo}:${hex.slice(0, CORPUS_HASH_DISPLAY_LEN)}`;
}

/** `hal-halueval-v1@sha256:2f9c1a…(1000 cases)` — the corpus half of a ruler string. */
export function describeCorpus(m: CorpusManifest): string {
  return `${m.corpusId}@${shortHash(m.contentHash)} (${m.caseCount} cases)`;
}

/**
 * True iff two manifests describe the SAME population. Compares the hash, not the id — an id can be
 * reused across a changed case set (that is exactly how `corpus v1` came to mean four things), so the
 * hash is the only field entitled to decide identity.
 */
export function isSameCorpus(a: CorpusManifest, b: CorpusManifest): boolean {
  return a.contentHash === b.contentHash;
}

/**
 * Guard for the operation that caused the original confusion: comparing two numbers.
 * Returns the reason two measurements are not comparable, or null if they are.
 */
export function corpusComparabilityFault(a: CorpusManifest, b: CorpusManifest): string | null {
  if (isSameCorpus(a, b)) return null;
  if (a.corpusId === b.corpusId) {
    return (
      `corpus id ${a.corpusId} refers to two different case sets ` +
      `(${shortHash(a.contentHash)}, ${a.caseCount} cases vs ${shortHash(b.contentHash)}, ${b.caseCount} cases) — ` +
      `same name, different population: not comparable`
    );
  }
  return `different corpora (${describeCorpus(a)} vs ${describeCorpus(b)}) — not comparable`;
}
