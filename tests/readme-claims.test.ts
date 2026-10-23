/**
 * README claims that were false on 2026-10-23 and must stay fixed (repo-alignment sprint).
 *
 * - A static "HAL: live" badge sat beside a /hal/stats that reported 0 classifications in 24h.
 *   The badges now read that endpoint, so this pins the fields they read to the route that
 *   serves them: renaming a field breaks the badge silently, and this test loudly.
 * - "zkRepID makes the score checkable without revealing it", while the proof statement carries
 *   the score in the clear (src/zkp/proof-statement-guard.ts).
 * - The checkers were "independent". They are different model families, whose errors still
 *   correlate (Kim et al., ICML 2025, arXiv 2506.07962).
 * - Work this repo uses was not credited.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const halStatsRoute = readFileSync(resolve(root, 'src/routes/hal-stats.ts'), 'utf8');

describe('README claims', () => {
  it('has no static "live" badge; every HAL badge reads a field /hal/stats actually returns', () => {
    expect(readme).not.toMatch(/img\.shields\.io\/badge\/HAL-live/);
    const queries = [...readme.matchAll(/badge\/dynamic\/json\?url=([^&)]+)&query=([^&)]+)/g)].map((m) => ({
      url: decodeURIComponent(m[1]!),
      field: decodeURIComponent(m[2]!).replace(/^\$\./, '').split('.').pop()!,
    }));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.url).toBe('https://repid-engine-production.up.railway.app/api/v1/hal/stats');
      expect(halStatsRoute).toMatch(new RegExp(`\\b${q.field}\\b`));
    }
  });

  it('never says the zkRepID proof hides the score', () => {
    for (const line of readme.split('\n').filter((l) => /zkRepID/.test(l))) {
      expect(line).not.toMatch(/without revealing|checkable without/i);
    }
  });

  it('never calls the checkers independent', () => {
    expect(readme).not.toMatch(/independen\w*\s+(model|famil|check|vote|voter|LLM)/i);
    expect(readme).not.toMatch(/vendor-independence|family-independence/i);
  });

  it('credits what this repository uses, and notes the one MIT file', () => {
    for (const name of ['Plonky3', 'x402', 'TruthfulQA', 'FEVER', 'HaluEval', 'contracts/RepIDStaking.sol']) {
      expect(readme).toContain(name);
    }
    expect(readFileSync(resolve(root, 'zkp-vault/Cargo.toml'), 'utf8')).toMatch(/^p3-poseidon2 =/m);
    expect(readFileSync(resolve(root, 'contracts/RepIDStaking.sol'), 'utf8')).toMatch(/SPDX-License-Identifier: MIT/);
  });
});
