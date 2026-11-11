import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANE_REPOS, validateSpec, type LaneSpec } from '../src/orchestration/t12-lane-store';

// Every committed spec file must hold only specs a lane may actually take. A spec that fails validateSpec
// is skipped silently by pickClaimable, so a bad line would sit in the queue and never be worked.
const FILES = ['ops/t12/specs.jsonl', 'ops/t12/g25/specs.jsonl'];
const load = (f: string): LaneSpec[] =>
  readFileSync(join(__dirname, '..', f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LaneSpec);

describe.each(FILES)('%s', (file) => {
  const specs = load(file);

  it('is not empty', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it.each(specs.map((s) => [s.id, s] as const))('%s passes validateSpec', (_id, s) => {
    expect(validateSpec(s)).toEqual([]);
  });

  it('targets only repos a lane may serve', () => {
    for (const s of specs) expect(LANE_REPOS).toContain(s.repo);
  });

  it('has unique ids and no two specs writing the same file', () => {
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    const paths = specs.flatMap((s) => s.paths.map((p) => `${s.repo}:${p.toLowerCase()}`));
    expect(new Set(paths).size).toBe(paths.length);
  });
});

it('the validity check catches a bad spec (positive control)', () => {
  const bad = { ...load(FILES[0]!)[0]!, verify: { runner: 'jest' as const, target: 'tests/elsewhere.test.ts', controls: [] } };
  expect(validateSpec(bad).length).toBeGreaterThan(0);
});
