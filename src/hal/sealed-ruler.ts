/**
 * HAL SEALED RULER — the only population HAL accuracy is measured on from 2026-10-16.
 * OUTPUT_PATH: src/hal/sealed-ruler.ts
 *
 * WHY
 * ---
 * Lane KQ published ~80% of `hal_test_cases` as a readable library (E:\dev\living-docs\knowledge).
 * A score on readable items measures recall of published answers, not detection. The remaining
 * ~20% is SEALED by a salted id hash:
 *
 *     sealed  ⇔  sha256("sealed-v1:" + id)[0] mod 5 == 0
 *
 * This module turns that predicate into a ruler (src/hal/corpus-manifest.ts + measurement-ruler.ts):
 * select sealed rows → drop versioned exclusions → sort by id → drop exact duplicate texts →
 * `computeCorpusHash`. The result is `hal-sealed-v<N>@sha256:<hash> (<n> cases)` (CLAUDE_RULES r24).
 *
 * RULES THIS FILE ENFORCES
 *   1. The salt never changes. The open 80% is public; a new salt would re-seal published items.
 *      A leaked sealed item is DROPPED by an exclusion entry in a NEW version (hash changes,
 *      version bumps). Exclusions are cumulative: v(N+1) excludes everything vN did.
 *   2. Each version pins its population (id-set hash + content hash + count). A database that no
 *      longer reproduces the pin (rows added, relabelled, deleted) is a different population, so
 *      the loader REFUSES rather than quietly measuring it under the old name. Mint the next version.
 *   3. No sealed id or text is written to the repo, logs or reports. The selection is computed at
 *      runtime from the DB; exclusions are stored as salted digests of ids, never ids; report lines
 *      carry only counts, hashes and metrics.
 *   4. A delta between two numbers is printed only when both carry the same ruler key
 *      (`formatDelta`); otherwise it throws IncomparableMeasurementError.
 *
 * Purity: no env reads and no network. `loadRulerSelection` takes the DB client as an argument.
 */
import { createHash } from 'crypto';
import {
  CorpusCase,
  CorpusManifest,
  InvalidCorpusError,
  buildCorpusManifest,
  describeCorpus,
  sortCasesById,
} from './corpus-manifest';
import {
  AccuracyMetric,
  ConfigurationWidth,
  ConfusionMatrix,
  HalStrictness,
  IncomparableMeasurementError,
  MeasurementRuler,
  RuledMeasurement,
  recordMeasurement,
} from './measurement-ruler';

/** NEVER CHANGE. Every published/sealed split in E:\dev\living-docs\knowledge depends on it. */
export const SEALED_SALT = 'sealed-v1:';

/** True iff the row id is in the sealed fifth. Same predicate as the SQL in the KQ report. */
export function isSealedId(id: string): boolean {
  return createHash('sha256').update(SEALED_SALT + id, 'utf8').digest()[0]! % 5 === 0;
}

/** What an exclusion entry stores: a salted digest of the id, so the repo never holds a sealed id. */
export function exclusionDigest(id: string): string {
  return createHash('sha256').update(`hal-sealed-exclusion:${id}`, 'utf8').digest('hex');
}

/** sha256 of the sorted ids joined by "\n" — the id-set hash format the KQ report uses. */
export function idSetSha256(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n'), 'utf8').digest('hex');
}

export interface SealedRulerVersion {
  version: number;
  /** exclusionDigest(id) of items dropped in THIS version. Effective set = union of v1..vN. */
  addExclusions: readonly string[];
  /** Why this version exists (the leak, the relabel). Never the item text. */
  reason: string;
  /** The population this version must reproduce, or the loader refuses. */
  pin: {
    /** idSetSha256 over ALL sealed hal_test_cases ids (before exclusions and de-duplication). */
    sealedIdSetSha256: string;
    /** computeCorpusHash of the final population. */
    contentHash: string;
    caseCount: number;
  };
}

/**
 * The versioned exclusion list. APPEND ONLY — never edit or delete an entry.
 *
 * To drop a leaked item: append `{ version: N+1, addExclusions: [exclusionDigest(id)], reason, pin }`
 * with the pin the new population produces, and quote results as hal-sealed-v<N+1>.
 *
 * v1 pin derived 2026-10-16 from Trinity prod by read-only SQL that replicates canonicalizeCase:
 * 524 sealed rows, 519 distinct texts, no conflicting labels among duplicates.
 * (The KQ report's `cddd45e2…` hash covers 546 ids: these 524 cases + 22 sealed hal_test_prompts.)
 */
export const SEALED_RULER_VERSIONS: readonly SealedRulerVersion[] = [
  {
    version: 1,
    addExclusions: [],
    reason: 'initial seal (KQ hard-questions commons, 2026-10-16)',
    pin: {
      sealedIdSetSha256: '051860599f9f44a5f7d68fb364e09239919b407c5c820740de7a144963cb94c5',
      contentHash: 'sha256:729698e2209cdbc0ed6a95bb2fa46cded9ca5bf5854c7986ec2ea0620875685f',
      caseCount: 519,
    },
  },
];

export const rulerIdFor = (version: number): string => `hal-sealed-v${version}`;

/** Default = the newest version, so a leak exclusion takes effect for every harness at once. */
export const DEFAULT_RULER_ID = rulerIdFor(
  SEALED_RULER_VERSIONS[SEALED_RULER_VERSIONS.length - 1]!.version,
);

/** The columns every ruler needs from `hal_test_cases`. */
export interface HalCaseRow {
  id: string;
  prompt_text: string;
  expected_hallucination: boolean;
  source?: string | null;
}

export interface RulerSelection<R extends HalCaseRow = HalCaseRow> {
  rulerId: string;
  version: number;
  /** The population, sorted by id, one row per distinct text. */
  rows: R[];
  manifest: CorpusManifest;
  stats: {
    tableRows: number;
    sealedRows: number;
    excluded: number;
    duplicateTextsDropped: number;
    conflictingLabelDropped: number;
    sealedIdSetSha256: string;
  };
}

/** Resolve the effective exclusion set for a ruler id, or throw naming the known ids. */
function resolveVersion(rulerId: string, versions: readonly SealedRulerVersion[]) {
  const idx = versions.findIndex((v) => rulerIdFor(v.version) === rulerId);
  if (idx < 0) {
    throw new InvalidCorpusError(
      `unknown ruler ${JSON.stringify(rulerId)}; known: ${versions.map((v) => rulerIdFor(v.version)).join(', ')}`,
    );
  }
  const excluded = new Set(versions.slice(0, idx + 1).flatMap((v) => v.addExclusions));
  return { v: versions[idx]!, excluded };
}

/**
 * Select a ruler's population from the full `hal_test_cases` table and verify it against the pin.
 * Throws InvalidCorpusError on a malformed row or a population that does not reproduce the pin.
 */
export function selectRuler<R extends HalCaseRow>(
  allRows: readonly R[],
  rulerId: string = DEFAULT_RULER_ID,
  versions: readonly SealedRulerVersion[] = SEALED_RULER_VERSIONS,
): RulerSelection<R> {
  const { v, excluded } = resolveVersion(rulerId, versions);

  const sealed = allRows.filter((r) => isSealedId(String(r.id)));
  for (const r of sealed) {
    // Refuse rather than coerce: a missing label silently read as "not a hallucination" is a wrong ruler.
    if (typeof r.expected_hallucination !== 'boolean' || typeof r.prompt_text !== 'string') {
      throw new InvalidCorpusError('a sealed row has a non-boolean label or non-string text; fix the row before measuring');
    }
  }
  const sealedIdSet = idSetSha256(sealed.map((r) => String(r.id)));

  const kept = sealed
    .filter((r) => !excluded.has(exclusionDigest(String(r.id))))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

  // Exact-text de-duplication: keep the lowest id. A text whose copies disagree on the label has no
  // gold answer, so every copy is dropped.
  const byText = new Map<string, R[]>();
  for (const r of kept) byText.set(r.prompt_text, [...(byText.get(r.prompt_text) ?? []), r]);
  const rows: R[] = [];
  let duplicateTextsDropped = 0;
  let conflictingLabelDropped = 0;
  for (const group of byText.values()) {
    if (new Set(group.map((r) => r.expected_hallucination)).size > 1) {
      conflictingLabelDropped += group.length;
      continue;
    }
    rows.push(group[0]!);
    duplicateTextsDropped += group.length - 1;
  }
  const cases = sortCasesById(rows.map(toCorpusCase));
  rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

  const manifest = buildCorpusManifest({
    corpusId: rulerId,
    cases,
    sources: [{ source: 'hal_test_cases', caseCount: cases.length, note: `sealed salt ${SEALED_SALT}` }],
  });

  const drift: string[] = [];
  if (sealedIdSet !== v.pin.sealedIdSetSha256) drift.push('sealed id set');
  if (manifest.contentHash !== v.pin.contentHash) drift.push('content hash');
  if (manifest.caseCount !== v.pin.caseCount) drift.push(`case count (${manifest.caseCount} vs pinned ${v.pin.caseCount})`);
  if (drift.length) {
    throw new InvalidCorpusError(
      `${rulerId} no longer reproduces its pin (${drift.join(', ')}): the table changed under this ruler. ` +
        `Do not measure under the old name; append version ${versions[versions.length - 1]!.version + 1} to SEALED_RULER_VERSIONS.`,
    );
  }

  return {
    rulerId,
    version: v.version,
    rows,
    manifest,
    stats: {
      tableRows: allRows.length,
      sealedRows: sealed.length,
      excluded: sealed.length - kept.length,
      duplicateTextsDropped,
      conflictingLabelDropped,
      sealedIdSetSha256: sealedIdSet,
    },
  };
}

function toCorpusCase(r: HalCaseRow): CorpusCase {
  return { id: String(r.id), text: r.prompt_text, expectedHallucination: r.expected_hallucination };
}

/** Minimal shape of a supabase-js client, so this module never imports one. */
export interface TableReader {
  from(table: string): any;
}

const PAGE = 1000;

/**
 * Read every `hal_test_cases` row (paged: PostgREST caps a response at 1000 rows, which silently
 * truncated the old harness), then `selectRuler`. `extraColumns` are carried through on each row.
 */
export async function loadRulerSelection<R extends HalCaseRow = HalCaseRow>(
  db: TableReader,
  rulerId: string = DEFAULT_RULER_ID,
  extraColumns: readonly string[] = [],
  versions: readonly SealedRulerVersion[] = SEALED_RULER_VERSIONS,
): Promise<RulerSelection<R>> {
  resolveVersion(rulerId, versions); // fail on a bad id before touching the DB
  const cols = [...new Set(['id', 'prompt_text', 'expected_hallucination', 'source', ...extraColumns])].join(', ');
  const all: R[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('hal_test_cases').select(cols).order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`[hal-sealed] read hal_test_cases failed: ${error.message}`);
    all.push(...((data ?? []) as R[]));
    if (!data || data.length < PAGE) break;
  }
  return selectRuler(all, rulerId, versions);
}

/** `--ruler <id>` from argv, else the default. Throws on an unknown id. */
export function rulerFromArgv(argv: readonly string[] = process.argv): string {
  const i = argv.indexOf('--ruler');
  const id = i >= 0 && argv[i + 1] ? argv[i + 1]! : DEFAULT_RULER_ID;
  resolveVersion(id, SEALED_RULER_VERSIONS);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Public-benchmark vs internal split. Public-benchmark answers are on the open internet, so the
// two halves measure different things and are always reported apart.
// ---------------------------------------------------------------------------------------------

export type ItemSplit = 'public-benchmark' | 'internal';

export const PUBLIC_BENCHMARK_SOURCE =
  /fever|halueval|truthfulqa|vitaminc|scifact|hotpotqa|triviaqa|squad|natural[-_ ]?questions|simpleqa|mmlu/i;

export function itemSplit(source: string | null | undefined): ItemSplit {
  return PUBLIC_BENCHMARK_SOURCE.test(source ?? '') ? 'public-benchmark' : 'internal';
}

/** One case as a harness scored it. The gold label comes from the selection, never the caller. */
export interface ScoredCase {
  id: string;
  predictedHallucination: boolean;
}

export interface RuledReport {
  lines: string[];
  overall: RuledMeasurement;
  bySplit: Partial<Record<ItemSplit, RuledMeasurement>>;
  /** breakdown name → group value → measurement. */
  byBreakdown: Record<string, Record<string, RuledMeasurement>>;
}

function matrixOf(rows: readonly HalCaseRow[], predicted: Map<string, boolean>): ConfusionMatrix {
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) {
    const p = predicted.get(String(r.id))!;
    if (r.expected_hallucination) p ? m.tp++ : m.fn++;
    else p ? m.fp++ : m.tn++;
  }
  return m;
}

const fmt = (x: number | null) => (x === null ? 'n/a' : x.toFixed(4));

/**
 * Turn a harness's predictions into report lines. Every line names the ruler id, hash and N.
 *
 * Scoring all of the selection cites the ruler itself. Scoring part of it (a sample, a category
 * filter) is a different population, so it is minted as `<ruler>/subset` with its own hash. The
 * public-benchmark and internal halves are minted as `<corpus>:public-benchmark` / `:internal`.
 */
export function ruledReport<R extends HalCaseRow>(
  sel: RulerSelection<R>,
  scored: readonly ScoredCase[],
  width: ConfigurationWidth,
  opts: {
    engineCommit?: string;
    /** Extra slices, e.g. { category: (r) => r.category }. Each group is minted `<corpus>:<name>=<value>`. */
    breakdowns?: Record<string, (row: R) => string | null | undefined>;
  } = {},
): RuledReport {
  const { engineCommit } = opts;
  const byId = new Map(sel.rows.map((r) => [String(r.id), r]));
  const predicted = new Map<string, boolean>();
  for (const s of scored) {
    if (!byId.has(s.id)) throw new InvalidCorpusError(`a scored case is not in ${sel.rulerId}; the ruler does not describe it`);
    if (predicted.has(s.id)) throw new InvalidCorpusError(`a case was scored twice in one ${sel.rulerId} run`);
    predicted.set(s.id, s.predictedHallucination);
  }
  const rows: R[] = sel.rows.filter((r) => predicted.has(String(r.id)));
  const base = rows.length === sel.rows.length ? sel.rulerId : `${sel.rulerId}/subset`;

  const measure = (corpusId: string, part: readonly HalCaseRow[]): RuledMeasurement => {
    const corpus =
      corpusId === sel.rulerId
        ? sel.manifest
        : buildCorpusManifest({ corpusId, cases: sortCasesById(part.map(toCorpusCase)) });
    const ruler: MeasurementRuler = { corpus, width, ...(engineCommit ? { engineCommit } : {}) };
    return recordMeasurement({ matrix: matrixOf(part, predicted), ruler });
  };
  const line = (tag: string, m: RuledMeasurement) =>
    `[${tag}] ${m.citation} | P=${fmt(m.metrics.precision)} R=${fmt(m.metrics.recall)} acc=${fmt(m.metrics.accuracy)} ` +
    `| tp=${m.matrix.tp} fp=${m.matrix.fp} fn=${m.matrix.fn} tn=${m.matrix.tn}`;

  if (rows.length === 0) throw new InvalidCorpusError(`no cases of ${sel.rulerId} were scored; nothing to report`);
  const overall = measure(base, rows);
  const lines = [
    `RULER ${sel.rulerId}@${sel.manifest.contentHash} N=${sel.manifest.caseCount} ` +
      `(sealed rows ${sel.stats.sealedRows}, excluded ${sel.stats.excluded}, text duplicates dropped ${sel.stats.duplicateTextsDropped}` +
      `${sel.stats.conflictingLabelDropped ? `, conflicting-label dropped ${sel.stats.conflictingLabelDropped}` : ''}; salt "${SEALED_SALT}")`,
    line('all', overall),
  ];
  const bySplit: RuledReport['bySplit'] = {};
  for (const split of ['public-benchmark', 'internal'] as const) {
    const part = rows.filter((r) => itemSplit(r.source) === split);
    if (part.length === 0) {
      lines.push(`[${split}] 0 cases of ${describeCorpus(overall.ruler.corpus)} — no score`);
      continue;
    }
    bySplit[split] = measure(`${base}:${split}`, part);
    lines.push(line(split, bySplit[split]!));
  }
  const byBreakdown: RuledReport['byBreakdown'] = {};
  for (const [name, key] of Object.entries(opts.breakdowns ?? {})) {
    byBreakdown[name] = {};
    const groups = new Map<string, R[]>();
    for (const r of rows) {
      const g = String(key(r) ?? 'unknown');
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    for (const [g, part] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      byBreakdown[name]![g] = measure(`${base}:${name}=${g}`, part);
      lines.push(line(`${name}=${g}`, byBreakdown[name]![g]!));
    }
  }
  return { lines, overall, bySplit, byBreakdown };
}

// ---------------------------------------------------------------------------------------------
// Delta guard.
// ---------------------------------------------------------------------------------------------

/**
 * Everything `assertComparable` checks, as one string: full corpus hash, observed width, strictness
 * and quorum gating. Two numbers are comparable iff their keys are equal.
 */
export function rulerKey(r: MeasurementRuler): string {
  const w = r.width;
  return (
    `${r.corpus.corpusId}@${r.corpus.contentHash}` +
    `|w${w.familiesMin}-${w.familiesMax}|s${w.strictness}|dq${w.decisionRequiresQuorum ? 1 : 0}|pq${w.penaltyRequiresQuorum ? 1 : 0}`
  );
}

/** Inverse of `rulerKey`. Null for anything that is not exactly that format. */
export function parseRulerKey(key: string): {
  corpusId: string;
  contentHash: string;
  familiesMin: number;
  familiesMax: number;
  strictness: HalStrictness;
  decisionRequiresQuorum: boolean;
  penaltyRequiresQuorum: boolean;
} | null {
  const m = /^([^@|]+)@([a-z0-9]+:[0-9a-f]{64})\|w(\d+)-(\d+)\|s([12])\|dq([01])\|pq([01])$/.exec(key);
  if (!m) return null;
  return {
    corpusId: m[1]!,
    contentHash: m[2]!,
    familiesMin: Number(m[3]),
    familiesMax: Number(m[4]),
    strictness: Number(m[5]) as HalStrictness,
    decisionRequiresQuorum: m[6] === '1',
    penaltyRequiresQuorum: m[7] === '1',
  };
}

/**
 * Decide whether a stored run may be published as a sealed-ruler measurement.
 *
 * `tags` are the run rows' harness_version values (`<harness version>|<rulerKey>`), `caseIds`
 * the cases it scored. Publishable only if every row carries the same tag, the tag names a
 * registered sealed version with its pinned hash, and the run scored exactly that version's N
 * distinct sealed cases. Anything else returns the reason, so the caller withholds the number.
 */
export function sealedRunRuler(
  tags: readonly (string | null | undefined)[],
  caseIds: readonly string[],
  versions: readonly SealedRulerVersion[] = SEALED_RULER_VERSIONS,
): { ok: true; rulerId: string; parsed: NonNullable<ReturnType<typeof parseRulerKey>> } | { ok: false; reason: string } {
  const distinctTags = new Set(tags.map((t) => t ?? ''));
  if (distinctTags.size !== 1) return { ok: false, reason: 'run rows carry different ruler tags' };
  const tag = [...distinctTags][0]!;
  const parsed = parseRulerKey(tag.slice(tag.indexOf('|') + 1));
  if (tag.indexOf('|') < 0 || !parsed) return { ok: false, reason: 'run carries no ruler' };
  const v = versions.find((x) => rulerIdFor(x.version) === parsed.corpusId && x.pin.contentHash === parsed.contentHash);
  if (!v) return { ok: false, reason: `${parsed.corpusId} is not a registered sealed ruler with that hash` };
  const ids = new Set(caseIds);
  if (ids.size !== caseIds.length || ids.size !== v.pin.caseCount || ![...ids].every(isSealedId)) {
    return { ok: false, reason: `run did not score exactly the ${v.pin.caseCount} cases of ${parsed.corpusId}` };
  }
  return { ok: true, rulerId: parsed.corpusId, parsed };
}

export interface KeyedValue {
  value: number | null;
  /** rulerKey() of the measurement; null/undefined for a number with no recorded ruler. */
  ruler: string | null | undefined;
}

/** A RuledMeasurement's metric with its key, ready for `formatDelta`. */
export function keyed(m: RuledMeasurement, metric: AccuracyMetric = 'f1'): KeyedValue {
  return { value: m.metrics[metric], ruler: rulerKey(m.ruler) };
}

/** The only way to print a change between two numbers. Throws unless both carry the same ruler key. */
export function formatDelta(metric: AccuracyMetric, current: KeyedValue, previous: KeyedValue): string {
  if (!current.ruler || !previous.ruler) {
    throw new IncomparableMeasurementError(`a ${metric} with no recorded ruler cannot be compared`);
  }
  if (current.ruler !== previous.ruler) {
    throw new IncomparableMeasurementError(
      `different rulers (${current.ruler} vs ${previous.ruler}); no ${metric} delta is printed`,
    );
  }
  if (current.value === null || previous.value === null) return `Δ${metric.toUpperCase()} n/a (undefined metric)`;
  const d = current.value - previous.value;
  return `Δ${metric.toUpperCase()} = ${d >= 0 ? '+' : ''}${d.toFixed(4)} (${previous.value.toFixed(4)} → ${current.value.toFixed(4)}) on ${current.ruler}`;
}

// ---------------------------------------------------------------------------------------------
// Width for in-process harnesses (halService.evaluate results).
// ---------------------------------------------------------------------------------------------

/** Families that answered one case: the extractor counts as one instrument; fact-check reads families_used. */
export function caseFamilies(strictness: HalStrictness, signals: Record<string, unknown> | undefined): number {
  if (strictness === 1) return 1;
  const f = signals?.families_used;
  return typeof f === 'number' && Number.isInteger(f) && f >= 0 ? f : 0;
}

/** Build the width half of the ruler. Quorum flags are passed in (the caller reads env). */
export function harnessWidth(args: {
  strictness: HalStrictness;
  familiesConfigured: number;
  perCaseFamilies: readonly number[];
  decisionRequiresQuorum: boolean;
  penaltyRequiresQuorum: boolean;
}): ConfigurationWidth {
  const fams = args.perCaseFamilies;
  return {
    familiesConfigured: args.strictness === 1 ? 1 : args.familiesConfigured,
    familiesMin: fams.length ? Math.min(...fams) : 0,
    familiesMax: fams.length ? Math.max(...fams) : 0,
    strictness: args.strictness,
    decisionRequiresQuorum: args.decisionRequiresQuorum,
    penaltyRequiresQuorum: args.penaltyRequiresQuorum,
  };
}
