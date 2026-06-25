/**
 * Round-6 parity gauntlet v3 — CC ACTUAL hardened gate @ pinned commit.
 * No hardened-reference shim. Stateful session attacks (cost burst, recon chains).
 */
import path from 'path';
import fs from 'fs';
import { runGauntletV3, formatScoreboardV3 } from '../../src/redteam/gauntlet-runner-v3';
import { ALL_V3_ATTACKS, ALL_V3_SEQUENCES } from '../../src/redteam/attacks/v3';
import { CC_GATE_COMMIT } from '../../src/redteam/gate-profiles/cc-actual-gate';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'redteam');

describe('governance red-team gauntlet v3 (CC parity)', () => {
  const expectedTotal = ALL_V3_ATTACKS.length + ALL_V3_SEQUENCES.length;

  it('uses CC actual gate commit pin', () => {
    expect(CC_GATE_COMMIT).toBe('5718d16');
  });

  it('runs full v3 corpus against cc-actual gate only', () => {
    expect(ALL_V3_ATTACKS.length).toBeGreaterThanOrEqual(75);
    expect(ALL_V3_SEQUENCES.length).toBe(4);
    expect(expectedTotal).toBeGreaterThanOrEqual(78);
  });

  it('produces round-6 parity scoreboard', () => {
    const sb = runGauntletV3({ repoRoot: REPO_ROOT });
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DOCS_DIR, 'scoreboard-round6-parity.json'),
      JSON.stringify(sb, null, 2)
    );

    expect(sb.profileId).toBe('cc-actual');
    expect(sb.ccGateCommit).toBe('5718d16');
    expect(sb.total).toBe(expectedTotal);
    expect(sb.caught + sb.breaches).toBe(sb.breachTests);

    // eslint-disable-next-line no-console
    console.log('\n' + formatScoreboardV3(sb));
  });

  it('session cost burst catches, lone $0.99 passes', () => {
    const sb = runGauntletV3({ repoRoot: REPO_ROOT });
    const burst = sb.sessionSequences.find((s) => s.id === 'sess-cost-burst');
    const lone = sb.results.find((r) => r.id === 'sess-cost-lone');
    expect(burst?.outcome).toBe('PASS');
    expect(lone?.outcome).toBe('PASS');
  });

  it('documents breach ids for round-6 report (honest)', () => {
    const sb = runGauntletV3({ repoRoot: REPO_ROOT });
    const breachIds = sb.holes.map((h) => h.id);
    const fpIds = sb.overBlocks.map((o) => o.id);
    const sessionIds = sb.sessionSequences.map((s) => `${s.id}=${s.outcome}`);

    // eslint-disable-next-line no-console
    console.log('BREACHES:', breachIds.join(', ') || '(none)');
    // eslint-disable-next-line no-console
    console.log('FALSE_POSITIVES:', fpIds.join(', ') || '(none)');
    // eslint-disable-next-line no-console
    console.log('SESSION:', sessionIds.join('; '));

    expect(Array.isArray(breachIds)).toBe(true);
  });
});