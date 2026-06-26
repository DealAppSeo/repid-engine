/**
 * Round-7 phase 2 — v3 gauntlet against CC WIRED gate (session default loop).
 */
import path from 'path';
import fs from 'fs';
import { runGauntletV3Wired, formatScoreboardV3 } from '../../src/redteam/gauntlet-runner-v3-wired';
import { CC_WIRED_GATE_PIN, CC_SESSION_COMMIT } from '../../src/redteam/gate-profiles/cc-wired-gate';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'redteam');

describe('governance red-team gauntlet v3 wired (round-7)', () => {
  it('pins CC session + wired gate commits', () => {
    expect(CC_SESSION_COMMIT).toBe('807537a');
    expect(CC_WIRED_GATE_PIN).toBe('807537a+wired');
  });

  it('produces wired-gate parity scoreboard', () => {
    const sb = runGauntletV3Wired({ repoRoot: REPO_ROOT });
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DOCS_DIR, 'scoreboard-round7-wired.json'),
      JSON.stringify(sb, null, 2)
    );

    expect(sb.profileId).toBe('cc-wired');
    expect(sb.ccGateCommit).toBe('807537a+wired');

    // eslint-disable-next-line no-console
    console.log('\n' + formatScoreboardV3(sb));
  });

  it('headline: PocketOS and Palisade chains flip to caught', () => {
    const sb = runGauntletV3Wired({ repoRoot: REPO_ROOT });
    const pocket = sb.sessionSequences.find((s) => s.id === 'sess-pocket-chain');
    const palisade = sb.sessionSequences.find((s) => s.id === 'sess-palisade-chain');

    // eslint-disable-next-line no-console
    console.log('POCKET:', pocket?.outcome, pocket?.stepTiers?.join('→'));
    // eslint-disable-next-line no-console
    console.log('PALISADE:', palisade?.outcome, palisade?.stepTiers?.join('→'));

    expect(pocket?.outcome).toBe('PASS');
    expect(palisade?.outcome).toBe('PASS');
  });

  it('documents breaches for round-7 report', () => {
    const sb = runGauntletV3Wired({ repoRoot: REPO_ROOT });
    // eslint-disable-next-line no-console
    console.log('BREACHES:', sb.holes.map((h) => h.id).join(', ') || '(none)');
    // eslint-disable-next-line no-console
    console.log(
      `catch: ${(sb.breachCatchRate * 100).toFixed(1)}% FP pass: ${(sb.falsePositivePassRate * 100).toFixed(1)}%`
    );
    expect(sb.caught + sb.breaches).toBe(sb.breachTests);
  });
});