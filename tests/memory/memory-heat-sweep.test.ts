import { runHeatEvictionSweep } from '../../src/memory/memory-heat-sweep';
import type { HeatLeaf } from '../../src/memory/memory-heat';

/** nowMs fixed so tests are deterministic */
const NOW = 1_000_000_000_000;

function leaf(
  id: string,
  lastAccessedMs: number,
  accessCount: number,
  isAnchored = false,
): HeatLeaf {
  return { id, lastAccessedMs, accessCount, isAnchored };
}

/** A leaf accessed right now (heat ≈ RECENCY_WEIGHT ≈ 0.618 → hot) */
const hotLeaf = () => leaf('hot', NOW, 1, false);
/** A leaf accessed 20 days ago with moderate frequency (heat ≈ 0.47 → warm) */
const warmLeaf = () => leaf('warm', NOW - 20 * 24 * 60 * 60 * 1000, 10, false);
/** A leaf never accessed (heat = 0 → cold) */
const coldLeaf = (id = 'cold') => leaf(id, 0, 0, false);
/** A leaf that is on-chain anchored */
const anchoredLeaf = () => leaf('anchored', 0, 0, true);
/**
 * A leaf cold but warming: accessed 45 days ago, accessCount 5.
 * heat = 0.618 * 2^(-45/30) + 0.382 * (5/50) ≈ 0.219 + 0.038 ≈ 0.257 → cold, above threshold 0.25.
 */
const warmingColdLeaf = () =>
  leaf('warming-cold', NOW - 45 * 24 * 60 * 60 * 1000, 5, false);

describe('runHeatEvictionSweep', () => {
  test('empty input returns empty report with zero stats', () => {
    const report = runHeatEvictionSweep([], { nowMs: NOW });
    expect(report.hot).toHaveLength(0);
    expect(report.warm).toHaveLength(0);
    expect(report.cold).toHaveLength(0);
    expect(report.onChain).toHaveLength(0);
    expect(report.evictionCandidates).toHaveLength(0);
    expect(report.reactivationCandidates).toHaveLength(0);
    expect(report.stats).toEqual({ total: 0, hotCount: 0, warmCount: 0, coldCount: 0, onChainCount: 0 });
  });

  test('all-hot leaves produce no eviction candidates', () => {
    const leaves = [hotLeaf(), hotLeaf()];
    leaves[0]!.id = 'h1';
    leaves[1]!.id = 'h2';
    const report = runHeatEvictionSweep(leaves, { nowMs: NOW });
    expect(report.hot).toHaveLength(2);
    expect(report.warm).toHaveLength(0);
    expect(report.cold).toHaveLength(0);
    expect(report.evictionCandidates).toHaveLength(0);
    expect(report.stats.hotCount).toBe(2);
    expect(report.stats.total).toBe(2);
  });

  test('all-cold leaves appear as eviction candidates (up to limit)', () => {
    const leaves = [coldLeaf('c1'), coldLeaf('c2'), coldLeaf('c3')];
    const report = runHeatEvictionSweep(leaves, { nowMs: NOW, evictionLimit: 2 });
    expect(report.cold).toHaveLength(3);
    expect(report.evictionCandidates).toHaveLength(2);
    expect(report.stats.coldCount).toBe(3);
  });

  test('mixed tiers are correctly distributed', () => {
    const leaves = [hotLeaf(), warmLeaf(), coldLeaf(), anchoredLeaf()];
    const report = runHeatEvictionSweep(leaves, { nowMs: NOW });
    expect(report.hot).toHaveLength(1);
    expect(report.warm).toHaveLength(1);
    expect(report.cold).toHaveLength(1);
    expect(report.onChain).toHaveLength(1);
    expect(report.stats.total).toBe(4);
    expect(
      report.stats.hotCount + report.stats.warmCount + report.stats.coldCount + report.stats.onChainCount,
    ).toBe(4);
  });

  test('on-chain leaves are never eviction or reactivation candidates', () => {
    const leaves = [anchoredLeaf(), anchoredLeaf()];
    leaves[0]!.id = 'a1';
    leaves[1]!.id = 'a2';
    const report = runHeatEvictionSweep(leaves, { nowMs: NOW });
    expect(report.onChain).toHaveLength(2);
    expect(report.evictionCandidates).toHaveLength(0);
    expect(report.reactivationCandidates).toHaveLength(0);
  });

  test('eviction candidates sorted coldest-first', () => {
    // c1 never accessed (heat=0), c2 accessed 45 days ago (warmer but still cold)
    const c1 = leaf('c1', 0, 0, false);
    const c2 = leaf('c2', NOW - 45 * 24 * 60 * 60 * 1000, 0, false);
    const report = runHeatEvictionSweep([c1, c2], { nowMs: NOW, evictionLimit: 10 });
    expect(report.evictionCandidates[0]!.id).toBe('c1');
    expect(report.evictionCandidates[1]!.id).toBe('c2');
  });

  test('reactivation candidates are cold leaves warming past threshold, sorted warmest-first', () => {
    const c1 = coldLeaf('c1'); // heat=0, below reactivation threshold
    const c2 = warmingColdLeaf(); // heat≈0.26, above default threshold 0.25
    c2.id = 'c2';
    const report = runHeatEvictionSweep([c1, c2], { nowMs: NOW, reactivationMinHeat: 0.25 });
    // c2 warms above threshold
    expect(report.reactivationCandidates.some((l) => l.id === 'c2')).toBe(true);
    // c1 (heat=0) is below threshold
    expect(report.reactivationCandidates.some((l) => l.id === 'c1')).toBe(false);
  });

  test('stats totals equal input length', () => {
    const leaves = [hotLeaf(), warmLeaf(), coldLeaf(), coldLeaf('c2'), anchoredLeaf()];
    const report = runHeatEvictionSweep(leaves, { nowMs: NOW });
    expect(report.stats.total).toBe(5);
    expect(
      report.stats.hotCount + report.stats.warmCount + report.stats.coldCount + report.stats.onChainCount,
    ).toBe(5);
  });

  test('eviction limit of 0 returns no candidates', () => {
    const leaves = [coldLeaf('c1'), coldLeaf('c2')];
    const report = runHeatEvictionSweep(leaves, { nowMs: NOW, evictionLimit: 0 });
    expect(report.evictionCandidates).toHaveLength(0);
    expect(report.cold).toHaveLength(2);
  });

  test('does not mutate input array', () => {
    const leaves = [hotLeaf(), coldLeaf()];
    const original = leaves.map((l) => ({ ...l }));
    runHeatEvictionSweep(leaves, { nowMs: NOW });
    expect(leaves[0]).toEqual(original[0]);
    expect(leaves[1]).toEqual(original[1]);
  });
});
