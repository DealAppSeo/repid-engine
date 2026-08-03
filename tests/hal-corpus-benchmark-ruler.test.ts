/**
 * The benchmark path carries its ruler.
 *
 * `scoreBenchmark` keeps its optional-ruler signature for back-compat, but a summary produced without
 * one is stamped UNRULED and cannot be recorded. `scoreBenchmarkRuled` makes the ruler a required
 * argument. Pure — the `evaluate` fn is a stub, so no provider keys and no network.
 */
import {
  BenchmarkItem,
  HalEvalLike,
  itemsToCorpusCases,
  manifestForItems,
  scoreBenchmark,
  scoreBenchmarkRuled,
} from '../src/hal/benchmark';
import {
  ConfigurationWidth,
  MeasurementRuler,
  MissingRulerError,
  recordMeasurement,
} from '../src/hal/measurement-ruler';
import { computeCorpusHash } from '../src/hal/corpus-manifest';

function items(n: number): BenchmarkItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `halueval-${i}`,
    dataset: 'halueval' as const,
    statement: `statement ${i}`,
    goldHallucination: i % 2 === 0,
  }));
}

/** Deterministic stub: vetoes exactly the gold-positive cases, so the matrix is perfect. */
const perfect = async (text: string): Promise<HalEvalLike> => {
  const idx = Number(text.split(' ')[1]);
  return { decision: idx % 2 === 0 ? 'vetoed' : 'clean', hal_score: 0.5 };
};

const WIDTH: ConfigurationWidth = {
  familiesConfigured: 2,
  familiesMin: 2,
  familiesMax: 2,
  strictness: 2,
  decisionRequiresQuorum: true,
  penaltyRequiresQuorum: true,
};

describe('items -> corpus cases', () => {
  it('preserves order and carries the gold label', () => {
    const cs = itemsToCorpusCases(items(3));
    expect(cs.map((c) => c.id)).toEqual(['halueval-0', 'halueval-1', 'halueval-2']);
    expect(cs.map((c) => c.expectedHallucination)).toEqual([true, false, true]);
  });

  it('omits context rather than setting it to undefined, so the hash is stable', () => {
    const withCtx = itemsToCorpusCases([{ ...items(1)[0]!, context: 'ctx' }]);
    const without = itemsToCorpusCases(items(1));
    expect('context' in without[0]!).toBe(false);
    expect(computeCorpusHash(withCtx)).not.toBe(computeCorpusHash(without));
  });

  it('manifestForItems describes the sliced population, not the whole file', () => {
    const all = items(100);
    const scored = all.slice(0, 10);
    const mAll = manifestForItems('halueval-v1', all);
    const mScored = manifestForItems('halueval-v1', scored);
    expect(mAll.caseCount).toBe(100);
    expect(mScored.caseCount).toBe(10);
    expect(mAll.contentHash).not.toBe(mScored.contentHash);
  });
});

describe('scoreBenchmark without a ruler is stamped UNRULED', () => {
  it('marks rulerStatus UNRULED and omits the ruled measurement', async () => {
    const s = await scoreBenchmark(items(10), perfect);
    expect(s.rulerStatus).toBe('UNRULED');
    expect(s.ruled).toBeUndefined();
  });

  it('an UNRULED summary cannot be turned into a recordable measurement', async () => {
    const s = await scoreBenchmark(items(10), perfect);
    expect(() =>
      recordMeasurement({ matrix: { tp: s.tp, fp: s.fp, fn: s.fn, tn: s.tn }, ruler: undefined }),
    ).toThrow(MissingRulerError);
  });

  it('still computes the legacy numeric fields, so existing callers keep working', async () => {
    const s = await scoreBenchmark(items(10), perfect);
    expect(s.tp).toBe(5);
    expect(s.tn).toBe(5);
    expect(s.fp).toBe(0);
    expect(s.fn).toBe(0);
    expect(typeof s.f1).toBe('number');
  });
});

describe('scoreBenchmarkRuled requires and attaches the ruler', () => {
  it('produces a citation naming corpus, hash, families and strictness', async () => {
    const its = items(10);
    const ruler: MeasurementRuler = { corpus: manifestForItems('halueval-v1', its), width: WIDTH };
    const s = await scoreBenchmarkRuled(its, perfect, { ruler });
    expect(s.rulerStatus).toBe('ruled');
    expect(s.ruled.citation).toMatch(
      /^F1 = 1\.0000 on corpus halueval-v1@sha256:[0-9a-f]{12} \(10 cases\) at 2 families, strictness 2$/,
    );
  });

  it('refuses at scoring time when the supplied ruler is incomplete', async () => {
    const its = items(10);
    const broken = { corpus: manifestForItems('halueval-v1', its) } as unknown as MeasurementRuler;
    await expect(scoreBenchmarkRuled(its, perfect, { ruler: broken })).rejects.toThrow(MissingRulerError);
  });

  it('refuses when the ruler describes a smaller population than was scored', async () => {
    const its = items(20);
    const ruler: MeasurementRuler = { corpus: manifestForItems('halueval-v1', its.slice(0, 5)), width: WIDTH };
    await expect(scoreBenchmarkRuled(its, perfect, { ruler })).rejects.toThrow(
      /does not describe the population measured/,
    );
  });

  it('two runs over different slices get different corpus hashes — so they cannot be silently trended', async () => {
    const a = items(10);
    const b = items(20);
    const ra: MeasurementRuler = { corpus: manifestForItems('halueval-v1', a), width: WIDTH };
    const rb: MeasurementRuler = { corpus: manifestForItems('halueval-v1', b), width: WIDTH };
    const sa = await scoreBenchmarkRuled(a, perfect, { ruler: ra });
    const sb = await scoreBenchmarkRuled(b, perfect, { ruler: rb });
    expect(sa.ruled.ruler.corpus.contentHash).not.toBe(sb.ruled.ruler.corpus.contentHash);
  });

  it('the ruled citation shows DEGRADED when the run narrowed below its configuration', async () => {
    const its = items(10);
    const ruler: MeasurementRuler = {
      corpus: manifestForItems('halueval-v1', its),
      width: { ...WIDTH, familiesConfigured: 5, familiesMin: 1, familiesMax: 2 },
    };
    const s = await scoreBenchmarkRuled(its, perfect, { ruler });
    expect(s.ruled.citation).toContain('[DEGRADED: configured 5]');
    expect(s.ruled.citation).toContain('1-2 families (observed)');
  });
});
