import { createHash } from 'node:crypto';
import { drawSample, flipByte, rankKey, shapeOf, wilson } from '../scripts/zkp/zk-truth-table';

// The P-15 table is only worth publishing if anyone can redraw the same rows from the seed.
describe('zk-truth-table seeded draw', () => {
  const pop = Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, shape: i % 10 === 0 ? 'a,b,c' : 'a,b' }));

  it('rankKey is sha256("<seed>:<id>"), the same key the printed SQL orders by', () => {
    expect(rankKey('s', 7)).toBe(createHash('sha256').update('s:7').digest('hex'));
  });

  it('same seed, same rows; different seed, different rows', () => {
    expect(drawSample(pop, 'p15', 5)).toEqual(drawSample([...pop].reverse(), 'p15', 5));
    expect(drawSample(pop, 'p15', 5)).not.toEqual(drawSample(pop, 'p16', 5));
  });

  it('takes the first k per shape by rank, and a small shape is not starved', () => {
    const ids = drawSample(pop, 'p15', 5);
    const shape = new Map(pop.map((p) => [p.id, p.shape]));
    expect(ids.filter((i) => shape.get(i) === 'a,b,c')).toHaveLength(5);
    expect(ids.filter((i) => shape.get(i) === 'a,b')).toHaveLength(5);
    const keys = ids.map((i) => rankKey('p15', i));
    expect([...keys].sort()).toEqual(keys);
  });

  it('shapeOf sorts keys and names a missing statement', () => {
    expect(shapeOf({ threshold: 1, repid_score: 2 })).toBe('repid_score,threshold');
    expect(shapeOf(null)).toBe('(none)');
  });

  it('flipByte changes exactly one byte', () => {
    const b64 = Buffer.alloc(64, 7).toString('base64');
    const a = Buffer.from(b64, 'base64'), b = Buffer.from(flipByte(b64), 'base64');
    expect([...a].filter((x, i) => x !== b[i])).toHaveLength(1);
  });

  it('wilson matches a known interval and is empty with no data', () => {
    const [lo, hi] = wilson(10, 10);
    expect(lo).toBeCloseTo(0.722, 3);
    expect(hi).toBe(1);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });
});
