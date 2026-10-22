/**
 * The L1 dry-run scenarios (scripts/l1/scenarios.ts) on the in-memory chain twin, so CI runs the same list the
 * Hardhat dry run (scripts/l1/dry-run.ts) runs. Throwaway keys in memory; no network, no node.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryChain } from '../scripts/e2e-local/arena/chain';
import { runScenarios, type ScenarioResult } from '../scripts/l1/scenarios';

jest.setTimeout(60_000);

describe('L1 dry run (in-memory chain, chain id 84532)', () => {
  let results: ScenarioResult[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'l1-dryrun-'));
  beforeAll(async () => {
    results = (await runScenarios(new MemoryChain(84532), dir)).results;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('ran every scenario, and every one held', () => {
    expect(results.length).toBe(20);
    expect(results.filter((r) => !r.pass).map((r) => ({ name: r.name, got: r.got }))).toEqual([]);
  });
  it('every refusal left the chain untouched; every settled payment is exactly one transaction', () => {
    for (const r of results) {
      const sent = r.buyer_tx_after - r.buyer_tx_before;
      const settled = (r.got.match(/SETTLED/g) ?? []).length;
      expect({ name: r.name, sent }).toEqual({ name: r.name, sent: settled });
    }
  });
});
