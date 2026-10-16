/**
 * hal-sealed-v<N>: the sealed ruler HAL accuracy is measured on (src/hal/sealed-ruler.ts).
 *
 * Fixtures only: synthetic ids of the form 00000000-0000-4000-8000-<12 digits>, synthetic texts.
 * No sealed id or text from the database appears here or in any output this suite checks.
 */
import { createHash } from 'crypto';
import { computeCorpusHash, InvalidCorpusError, sortCasesById } from '../src/hal/corpus-manifest';
import {
  assertComparable,
  ConfigurationWidth,
  IncomparableMeasurementError,
  RuledMeasurement,
  recordMeasurement,
} from '../src/hal/measurement-ruler';
import {
  DEFAULT_RULER_ID,
  HalCaseRow,
  RulerSelection,
  ScoredCase,
  SEALED_RULER_VERSIONS,
  SEALED_SALT,
  SealedRulerVersion,
  exclusionDigest,
  formatDelta,
  idSetSha256,
  isSealedId,
  itemSplit,
  keyed,
  loadRulerSelection,
  parseRulerKey,
  ruledReport,
  rulerFromArgv,
  rulerKey,
  selectRuler,
} from '../src/hal/sealed-ruler';

const fx = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ALL_IDS = Array.from({ length: 200 }, (_, i) => fx(i));
const SEALED_IDS = ALL_IDS.filter(isSealedId);
const OPEN_IDS = ALL_IDS.filter((id) => !isSealedId(id));

const W: ConfigurationWidth = {
  familiesConfigured: 3,
  familiesMin: 3,
  familiesMax: 3,
  strictness: 2,
  decisionRequiresQuorum: true,
  penaltyRequiresQuorum: false,
};

/**
 * 10 sealed rows (S0..S9) and 4 open rows. S1 duplicates S0's text with the same label (dropped as a
 * duplicate); S3 duplicates S2's text with the opposite label (both dropped: no gold answer).
 */
function fixtureRows(): HalCaseRow[] {
  const s = SEALED_IDS.slice(0, 10);
  const rows: HalCaseRow[] = s.map((id, i) => ({
    id,
    prompt_text: `sealed fixture claim ${i}`,
    expected_hallucination: i % 2 === 0,
    source: i < 5 ? 'external-fever-fixture' : 't12-fixture',
  }));
  rows[1]!.prompt_text = rows[0]!.prompt_text;
  rows[1]!.expected_hallucination = rows[0]!.expected_hallucination;
  rows[3]!.prompt_text = rows[2]!.prompt_text;
  rows[3]!.expected_hallucination = !rows[2]!.expected_hallucination;
  for (const [i, id] of OPEN_IDS.slice(0, 4).entries()) {
    rows.push({ id, prompt_text: `open fixture claim ${i}`, expected_hallucination: true, source: 't12-fixture' });
  }
  return rows.reverse(); // arrival order must not matter
}

/** The population the ruler should select, computed independently of selectRuler. */
function expectedPopulation(rows: HalCaseRow[], excluded: Set<string> = new Set()) {
  const s = SEALED_IDS.slice(0, 10);
  const keep = [s[0]!, ...s.slice(4)].filter((id) => !excluded.has(id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cases = sortCasesById(
    keep.map((id) => ({ id, text: byId.get(id)!.prompt_text, expectedHallucination: byId.get(id)!.expected_hallucination })),
  );
  return { ids: cases.map((c) => c.id), contentHash: computeCorpusHash(cases) };
}

function versions(...exclusionsPerVersion: string[][]): SealedRulerVersion[] {
  const rows = fixtureRows();
  const sealedIdSetSha256 = idSetSha256(rows.map((r) => r.id).filter(isSealedId));
  const cumulative = new Set<string>();
  return exclusionsPerVersion.map((ids, i) => {
    ids.forEach((id) => cumulative.add(id));
    const exp = expectedPopulation(rows, cumulative);
    return {
      version: i + 1,
      addExclusions: ids.map(exclusionDigest),
      reason: `fixture v${i + 1}`,
      pin: { sealedIdSetSha256, contentHash: exp.contentHash, caseCount: exp.ids.length },
    };
  });
}

describe('sealed predicate (the salt never changes)', () => {
  it('reproduces the sha256("sealed-v1:"+id)[0] % 5 rule on pinned fixture ids', () => {
    expect(SEALED_SALT).toBe('sealed-v1:');
    const sealedInFirst20 = ALL_IDS.slice(0, 20).filter(isSealedId).map((id) => id.slice(-2));
    expect(sealedInFirst20).toEqual(['01', '08', '12', '13', '18']);
  });

  it('seals roughly one fifth', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `fixture-${i}`);
    const rate = ids.filter(isSealedId).length / ids.length;
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.25);
  });
});

describe('the versioned registry', () => {
  it('starts at hal-sealed-v1, is contiguous, and defaults to the newest version', () => {
    expect(SEALED_RULER_VERSIONS[0]!.version).toBe(1);
    SEALED_RULER_VERSIONS.forEach((v, i) => expect(v.version).toBe(i + 1));
    expect(DEFAULT_RULER_ID).toBe(`hal-sealed-v${SEALED_RULER_VERSIONS.length}`);
    expect(SEALED_RULER_VERSIONS[0]!.addExclusions).toEqual([]);
  });

  it('pins every version and stores exclusions as digests, never raw ids', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const v of SEALED_RULER_VERSIONS) {
      expect(v.pin.sealedIdSetSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(v.pin.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Number.isInteger(v.pin.caseCount) && v.pin.caseCount > 0).toBe(true);
      for (const d of v.addExclusions) {
        expect(d).toMatch(/^[0-9a-f]{64}$/);
        expect(d).not.toMatch(uuid);
      }
    }
  });

  it('v1 pin: 519 cases', () => {
    expect(SEALED_RULER_VERSIONS[0]!.pin.caseCount).toBe(519);
  });
});

describe('selectRuler', () => {
  it('selects sealed rows only, drops exact duplicate texts, drops conflicting labels, sorts, and hashes', () => {
    const rows = fixtureRows();
    const sel = selectRuler(rows, 'hal-sealed-v1', versions([]));
    const exp = expectedPopulation(rows);
    expect(sel.rows.map((r) => r.id)).toEqual(exp.ids);
    expect(sel.rows.every((r) => isSealedId(r.id))).toBe(true);
    expect(sel.manifest.corpusId).toBe('hal-sealed-v1');
    expect(sel.manifest.contentHash).toBe(exp.contentHash);
    expect(sel.manifest.caseCount).toBe(7);
    expect(sel.stats).toMatchObject({ tableRows: 14, sealedRows: 10, excluded: 0, duplicateTextsDropped: 1, conflictingLabelDropped: 2 });
  });

  it('refuses a table that no longer reproduces the pin', () => {
    const v = versions([]);
    const added = [...fixtureRows(), { id: SEALED_IDS[20]!, prompt_text: 'new sealed fixture', expected_hallucination: true }];
    expect(() => selectRuler(added, 'hal-sealed-v1', v)).toThrow(/no longer reproduces its pin.*sealed id set/);

    const relabelled = fixtureRows().map((r) => (r.id === SEALED_IDS[6] ? { ...r, expected_hallucination: !r.expected_hallucination } : r));
    expect(() => selectRuler(relabelled, 'hal-sealed-v1', v)).toThrow(/content hash/);
  });

  it('drops a leaked item only in a new version; the hash changes and exclusions are cumulative', () => {
    const leaked1 = SEALED_IDS[5]!;
    const leaked2 = SEALED_IDS[7]!;
    const v = versions([], [leaked1], [leaked2]);
    const rows = fixtureRows();
    const s1 = selectRuler(rows, 'hal-sealed-v1', v);
    const s2 = selectRuler(rows, 'hal-sealed-v2', v);
    const s3 = selectRuler(rows, 'hal-sealed-v3', v);
    expect(s1.rows.map((r) => r.id)).toContain(leaked1);
    expect(s2.rows.map((r) => r.id)).not.toContain(leaked1);
    expect(s3.rows.map((r) => r.id)).not.toContain(leaked1); // inherited from v2
    expect(s3.rows.map((r) => r.id)).not.toContain(leaked2);
    expect(new Set([s1.manifest.contentHash, s2.manifest.contentHash, s3.manifest.contentHash]).size).toBe(3);
    expect([s1.version, s2.version, s3.version]).toEqual([1, 2, 3]);
    expect(s3.stats.excluded).toBe(2);
  });

  it('refuses an unknown ruler id and a row with a non-boolean label', () => {
    expect(() => selectRuler(fixtureRows(), 'hal-open-v1', versions([]))).toThrow(InvalidCorpusError);
    const bad = fixtureRows().map((r) => (r.id === SEALED_IDS[4] ? { ...r, expected_hallucination: null as unknown as boolean } : r));
    expect(() => selectRuler(bad, 'hal-sealed-v1', versions([]))).toThrow(/non-boolean label/);
  });

  it('rulerFromArgv defaults to the newest version and refuses unknown ids', () => {
    expect(rulerFromArgv(['node', 'x'])).toBe(DEFAULT_RULER_ID);
    expect(rulerFromArgv(['node', 'x', '--ruler', 'hal-sealed-v1'])).toBe('hal-sealed-v1');
    expect(() => rulerFromArgv(['node', 'x', '--ruler', 'hal-everything'])).toThrow(InvalidCorpusError);
  });
});

describe('loadRulerSelection', () => {
  it('reads every page, not just the first 1000 rows', async () => {
    const big: HalCaseRow[] = Array.from({ length: 2500 }, (_, i) => ({
      id: fx(1000 + i),
      prompt_text: `page fixture ${i}`,
      expected_hallucination: i % 3 === 0,
      source: null,
    }));
    const sealed = big.filter((r) => isSealedId(r.id));
    const cases = sortCasesById(sealed.map((r) => ({ id: r.id, text: r.prompt_text, expectedHallucination: r.expected_hallucination })));
    const v: SealedRulerVersion[] = [{
      version: 1, addExclusions: [], reason: 'fixture',
      pin: { sealedIdSetSha256: idSetSha256(sealed.map((r) => r.id)), contentHash: computeCorpusHash(cases), caseCount: cases.length },
    }];
    const db = {
      from: () => ({
        select: () => ({ order: () => ({ range: async (a: number, b: number) => ({ data: big.slice(a, b + 1), error: null }) }) }),
      }),
    };
    const sel = await loadRulerSelection(db, 'hal-sealed-v1', [], v);
    expect(sel.stats.tableRows).toBe(2500);
    expect(sel.manifest.caseCount).toBe(sealed.length);
  });
});

describe('ruledReport', () => {
  const rows = fixtureRows();
  let sel: RulerSelection;
  let all: ScoredCase[];
  beforeAll(() => {
    // in beforeAll, not at describe time, so a selection failure fails tests instead of the suite
    sel = selectRuler(rows, 'hal-sealed-v1', versions([]));
    all = sel.rows.map((r) => ({ id: r.id, predictedHallucination: true }));
  });

  it('prints the ruler id, hash and N on every line and splits public-benchmark vs internal', () => {
    const rep = ruledReport(sel, all, W);
    expect(rep.lines[0]).toContain(`RULER hal-sealed-v1@${sel.manifest.contentHash} N=7`);
    for (const l of rep.lines.slice(1)) expect(l).toMatch(/hal-sealed-v1[^@ ]*@sha256:[0-9a-f]{12}.* \(\d+ cases\)/);
    expect(rep.overall.ruler.corpus).toBe(sel.manifest);
    expect(rep.overall.citation).toContain('hal-sealed-v1@sha256:');
    const pub = rep.bySplit['public-benchmark']!;
    const internal = rep.bySplit.internal!;
    expect(pub.ruler.corpus.corpusId).toBe('hal-sealed-v1:public-benchmark');
    expect(internal.ruler.corpus.corpusId).toBe('hal-sealed-v1:internal');
    expect(pub.ruler.corpus.caseCount + internal.ruler.corpus.caseCount).toBe(7);
    // Gold labels come from the selection: everything predicted positive → tp = positives, fp = negatives.
    const positives = sel.rows.filter((r) => r.expected_hallucination).length;
    expect(rep.overall.matrix).toEqual({ tp: positives, fp: 7 - positives, fn: 0, tn: 0 });
  });

  it('never prints a case id or text', () => {
    const rep = ruledReport(sel, all, W, { breakdowns: { source: (r) => r.source } });
    const out = rep.lines.join('\n');
    for (const r of rows) {
      expect(out).not.toContain(r.id);
      expect(out).not.toContain(r.prompt_text);
    }
  });

  it('mints a partial run as <ruler>/subset with its own hash', () => {
    const rep = ruledReport(sel, all.slice(0, 3), W);
    expect(rep.overall.ruler.corpus.corpusId).toBe('hal-sealed-v1/subset');
    expect(rep.overall.ruler.corpus.contentHash).not.toBe(sel.manifest.contentHash);
    expect(rep.overall.ruler.corpus.caseCount).toBe(3);
  });

  it('refuses a case outside the ruler and a case scored twice', () => {
    expect(() => ruledReport(sel, [...all, { id: OPEN_IDS[0]!, predictedHallucination: true }], W)).toThrow(/not in hal-sealed-v1/);
    expect(() => ruledReport(sel, [...all, all[0]!], W)).toThrow(/scored twice/);
  });

  it('breakdown slices carry their own corpus id', () => {
    const rep = ruledReport(sel, all, W, { breakdowns: { source: (r) => r.source } });
    expect(Object.keys(rep.byBreakdown.source!).sort()).toEqual(['external-fever-fixture', 't12-fixture']);
    expect(rep.byBreakdown.source!['t12-fixture']!.ruler.corpus.corpusId).toBe('hal-sealed-v1:source=t12-fixture');
  });
});

describe('itemSplit', () => {
  it.each([
    ['external-fever-20260608-n300', 'public-benchmark'],
    ['external-halueval-20260606', 'public-benchmark'],
    ['external-truthfulqa-20260608-n300', 'public-benchmark'],
    ['t12-expansion-20260616', 'internal'],
    ['verified-math', 'internal'],
    [null, 'internal'],
  ])('%s → %s', (source, split) => {
    expect(itemSplit(source)).toBe(split);
  });
});

describe('formatDelta refuses to compare across rulers', () => {
  let sel: RulerSelection;
  let allIds: string[];
  let a: RuledMeasurement;
  let b: RuledMeasurement;
  beforeAll(() => {
    sel = selectRuler(fixtureRows(), 'hal-sealed-v1', versions([]));
    allIds = sel.rows.map((r) => r.id);
    a = ruledReport(sel, allIds.map((id) => ({ id, predictedHallucination: true })), W).overall;
    b = ruledReport(sel, allIds.map((id, i) => ({ id, predictedHallucination: i % 2 === 0 })), W).overall;
  });

  it('prints a delta on the same ruler', () => {
    const line = formatDelta('f1', keyed(b), keyed(a));
    expect(line).toMatch(/^ΔF1 = [+-]\d\.\d{4} \(/);
    expect(line).toContain(sel.manifest.contentHash);
  });

  it('refuses a delta between different corpus hashes', () => {
    const sub = ruledReport(sel, allIds.slice(0, 3).map((id) => ({ id, predictedHallucination: true })), W).overall;
    expect(() => formatDelta('f1', keyed(a), keyed(sub))).toThrow(IncomparableMeasurementError);
  });

  it('refuses a number with no recorded ruler (every pre-sealed F1)', () => {
    expect(() => formatDelta('f1', keyed(a), { value: 0.89, ruler: '1.0.0' })).toThrow(IncomparableMeasurementError);
    expect(() => formatDelta('f1', keyed(a), { value: 0.89, ruler: null })).toThrow(IncomparableMeasurementError);
  });

  it('rulerKey differs exactly when assertComparable refuses', () => {
    const variants: Partial<ConfigurationWidth>[] = [
      {},
      { familiesMin: 2 },
      { familiesMax: 4 },
      { strictness: 1 },
      { decisionRequiresQuorum: false },
      { penaltyRequiresQuorum: true },
      { familiesConfigured: 5 }, // configured alone does not change the instrument
    ];
    const ms = variants.map((w) =>
      recordMeasurement({ matrix: { tp: 1, fp: 1, fn: 1, tn: 1 }, ruler: { corpus: sel.manifest, width: { ...W, ...w } } }),
    );
    for (const x of ms) {
      for (const y of ms) {
        let comparable = true;
        try { assertComparable(x, y); } catch { comparable = false; }
        expect(rulerKey(x.ruler) === rulerKey(y.ruler)).toBe(comparable);
      }
    }
  });
});

describe('source hygiene', () => {
  it('sealed-ruler.ts holds no uuid literal (no sealed id in the repo)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'hal', 'sealed-ruler.ts'), 'utf8');
    expect(src).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // and the exclusion digest is salted, so it is not sha256(id)
    expect(exclusionDigest('x')).not.toBe(createHash('sha256').update('x').digest('hex'));
  });
});

describe('parseRulerKey', () => {
  it('inverts rulerKey and rejects anything else', () => {
    const sel = selectRuler(fixtureRows(), 'hal-sealed-v1', versions([]));
    const m = recordMeasurement({ matrix: { tp: 1, fp: 0, fn: 0, tn: 1 }, ruler: { corpus: sel.manifest, width: W } });
    expect(parseRulerKey(rulerKey(m.ruler))).toEqual({
      corpusId: 'hal-sealed-v1',
      contentHash: sel.manifest.contentHash,
      familiesMin: 3,
      familiesMax: 3,
      strictness: 2,
      decisionRequiresQuorum: true,
      penaltyRequiresQuorum: false,
    });
    expect(parseRulerKey('1.0.0')).toBeNull();
    expect(parseRulerKey(`${rulerKey(m.ruler)}|extra`)).toBeNull();
    expect(parseRulerKey(rulerKey(m.ruler).replace(/[0-9a-f]{64}/, 'abc'))).toBeNull();
  });
});

describe('run-labeled-corpus never copies case text into hal_runner_results', () => {
  it('stores a sha256 digest in generated_answer, not prompt_text', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'hal-eval', 'run-labeled-corpus.ts'), 'utf8');
    const values = [...src.matchAll(/generated_answer:\s*([^\n]+)/g)].map((x: RegExpMatchArray) => x[1]!.trim());
    expect(values.length).toBe(1);
    expect(values[0]).toMatch(/^`sha256:\$\{createHash\('sha256'\)\.update\(String\(c\.prompt_text\), 'utf8'\)\.digest\('hex'\)\}`,$/);
  });
});
