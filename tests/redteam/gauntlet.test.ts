/**
 * Governance break-it gauntlet — runs builtin attacks, emits scoreboard.
 * Breaches are reported, not hidden (see XC_round4_report.md).
 */
import path from 'path';
import fs from 'fs';
import { runGauntlet, formatScoreboard } from '../../src/redteam/gauntlet-runner';
import { BUILTIN_ATTACKS } from '../../src/redteam/attacks/builtin';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCOREBOARD_PATH = path.join(REPO_ROOT, '.redteam-scoreboard.json');

describe('governance red-team gauntlet', () => {
  it('runs all builtin attacks and produces a scoreboard', () => {
    expect(BUILTIN_ATTACKS.length).toBeGreaterThanOrEqual(20);

    const sb = runGauntlet({ repoRoot: REPO_ROOT });
    fs.writeFileSync(SCOREBOARD_PATH, JSON.stringify(sb, null, 2));

    expect(sb.total).toBe(BUILTIN_ATTACKS.length);
    expect(sb.caught + sb.breaches).toBe(sb.total);
    expect(sb.catchRate).toBeGreaterThanOrEqual(0);
    expect(sb.catchRate).toBeLessThanOrEqual(1);

    // eslint-disable-next-line no-console
    console.log('\n' + formatScoreboard(sb));
  });

  it('documents breach ids for the round-4 report (honest, not failing on holes)', () => {
    const sb = runGauntlet({ repoRoot: REPO_ROOT });
    const breachIds = sb.holes.map((h) => h.attack.id);
    // eslint-disable-next-line no-console
    console.log('BREACH_IDS:', breachIds.join(', ') || '(none)');
    expect(Array.isArray(breachIds)).toBe(true);
  });
});