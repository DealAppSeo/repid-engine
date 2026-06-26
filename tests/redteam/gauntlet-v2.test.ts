/**
 * Round-5 red-team gauntlet v2 — dual scoreboard (pre-harden vs hardened-reference).
 * Breaches and false-positives reported honestly; see XC_round5_report.md.
 */
import path from 'path';
import fs from 'fs';
import {
  runGauntletV2,
  runDualScoreboard,
  formatScoreboardV2,
} from '../../src/redteam/gauntlet-runner-v2';
import { ALL_V2_ATTACKS, V2_SEQUENCES } from '../../src/redteam/attacks/v2';
import { PRE_HARDEN_PROFILE, HARDENED_REFERENCE_PROFILE } from '../../src/redteam/gate-profiles';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'redteam');

function writeJson(name: string, data: unknown): void {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, name), JSON.stringify(data, null, 2));
}

describe('governance red-team gauntlet v2', () => {
  const expectedTotal = ALL_V2_ATTACKS.length + V2_SEQUENCES.length;

  it('runs full v2 corpus (legacy r4 + 7 classes + sequences)', () => {
    expect(ALL_V2_ATTACKS.length).toBeGreaterThanOrEqual(70);
    expect(V2_SEQUENCES.length).toBeGreaterThanOrEqual(4);
    expect(expectedTotal).toBeGreaterThanOrEqual(80);
  });

  it('produces pre-harden scoreboard snapshot', () => {
    const sb = runGauntletV2(PRE_HARDEN_PROFILE, { repoRoot: REPO_ROOT });
    writeJson('scoreboard-round5-before.json', sb);

    expect(sb.total).toBe(expectedTotal);
    expect(sb.caught + sb.breaches).toBe(sb.breachTests);
    expect(sb.breachCatchRate).toBeGreaterThanOrEqual(0);
    expect(sb.breachCatchRate).toBeLessThanOrEqual(1);

    // eslint-disable-next-line no-console
    console.log('\n' + formatScoreboardV2(sb));
  });

  it('produces hardened-reference scoreboard snapshot', () => {
    const sb = runGauntletV2(HARDENED_REFERENCE_PROFILE, { repoRoot: REPO_ROOT });
    writeJson('scoreboard-round5-after.json', sb);

    expect(sb.total).toBe(expectedTotal);
    expect(sb.breachCatchRate).toBeGreaterThanOrEqual(0);

    // eslint-disable-next-line no-console
    console.log('\n' + formatScoreboardV2(sb));
  });

  it('produces dual delta + coverage map', () => {
    const dual = runDualScoreboard({ repoRoot: REPO_ROOT });
    writeJson('scoreboard-round5-dual.json', dual);

    expect(dual.before.profileId).toBe('pre-harden');
    expect(dual.after.profileId).toBe('hardened-reference');
    expect(dual.coverageMap.length).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log('\n=== DUAL DELTA ===');
    // eslint-disable-next-line no-console
    console.log(
      `before: ${(dual.before.breachCatchRate * 100).toFixed(1)}% | after: ${(dual.after.breachCatchRate * 100).toFixed(1)}% | delta: ${(dual.delta.breachCatchRate * 100).toFixed(1)}pp`
    );
    // eslint-disable-next-line no-console
    console.log(
      `FP pass before: ${(dual.before.falsePositivePassRate * 100).toFixed(1)}% | after: ${(dual.after.falsePositivePassRate * 100).toFixed(1)}%`
    );
    // eslint-disable-next-line no-console
    console.log('closed:', dual.delta.breachesClosed.join(', ') || '(none)');
    // eslint-disable-next-line no-console
    console.log('new breaches:', dual.delta.newBreaches.join(', ') || '(none)');
  });

  it('documents breach ids for round-5 report (honest — does not fail on holes)', () => {
    const dual = runDualScoreboard({ repoRoot: REPO_ROOT });
    const beforeIds = dual.before.holes.map((h) => h.id);
    const afterIds = dual.after.holes.map((h) => h.id);
    const fpIds = dual.after.overBlocks.map((o) => o.id);

    // eslint-disable-next-line no-console
    console.log('BEFORE_BREACHES:', beforeIds.join(', ') || '(none)');
    // eslint-disable-next-line no-console
    console.log('AFTER_BREACHES:', afterIds.join(', ') || '(none)');
    // eslint-disable-next-line no-console
    console.log('FALSE_POSITIVES:', fpIds.join(', ') || '(none)');

    expect(Array.isArray(beforeIds)).toBe(true);
    expect(Array.isArray(afterIds)).toBe(true);
  });
});