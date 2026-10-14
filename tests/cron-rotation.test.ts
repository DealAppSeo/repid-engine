/**
 * How many providers the daily minter attests per run, and which.
 *
 * One per run was an 11-day rotation over 11 eligible providers [MEASURED 2026-10-14], while
 * trustshell's acceptance gate fails a served zkRepID proof older than 7 days. The run is now
 * sized from a freshness target: perRun = ceil(eligible / targetDays), capped for cost.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A file:// URL, not a bare path: on Windows the ESM loader rejects `C:\...` (ERR_UNSUPPORTED_ESM_URL_SCHEME),
// which turns every case red for a reason that has nothing to do with the logic.
const MODULE = pathToFileURL(join(__dirname, '..', 'scripts', 'cron', 'rotation.mjs')).href;

/** Exercise the real module in a real node, the way the cron will. */
function run(body: string): unknown {
  const src = `import { providersPerRun, pickStalest } from ${JSON.stringify(MODULE)};\n${body}`;
  return JSON.parse(execFileSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8' }).trim());
}

const perRun = (n: number, target: number, cap: number) =>
  run(`console.log(JSON.stringify(providersPerRun(${n}, ${target}, ${cap})));`) as number;

describe('providersPerRun — the rotation fits inside the freshness target', () => {
  it('11 providers at a 4-day target is 3 per run, so each is renewed every <= 4 days', () => {
    const n = perRun(11, 4, 4);
    expect(n).toBe(3);
    expect(Math.ceil(11 / n)).toBeLessThanOrEqual(4);
  });

  it('the measured roster can never again be an 11-day cycle against a 7-day gate', () => {
    expect(Math.ceil(11 / perRun(11, 4, 4))).toBeLessThan(7);
  });

  it('the cost cap wins over the target', () => {
    expect(perRun(40, 4, 4)).toBe(4);
  });

  it('a small roster still runs at least one, and an empty one runs none', () => {
    expect(perRun(2, 4, 4)).toBe(1);
    expect(perRun(0, 4, 4)).toBe(0);
  });

  it('a nonsense target or cap throws instead of silently attesting nobody', () => {
    // Asserted inside node, so a failed import cannot pass for a throw.
    const threw = (args: string) =>
      run(`try { providersPerRun(${args}); console.log('"returned"'); } catch { console.log('"threw"'); }`);
    expect(threw('11, 0, 4')).toBe('threw');
    expect(threw('11, 4, 0')).toBe('threw');
    expect(threw('11, 4, 4')).toBe('returned');
  });
});

describe('pickStalest — oldest write first, each provider once', () => {
  it('picks never-written first, then oldest, and dedupes a provider with two services', () => {
    const picked = run(`
      const e = (svc, prov) => ({ svc: { id: svc }, prov: { id: prov } });
      const eligible = [e('s1', 'fresh'), e('s2', 'old'), e('s3', 'never'), e('s4', 'old'), e('s5', 'mid')];
      const last = new Map([['fresh', '2026-10-13T12:00:00Z'], ['old', '2026-10-03T12:00:00Z'], ['mid', '2026-10-08T12:00:00Z']]);
      console.log(JSON.stringify(pickStalest(eligible, last, 3).map((x) => x.prov.id)));
    `);
    expect(picked).toEqual(['never', 'old', 'mid']);
  });
});
