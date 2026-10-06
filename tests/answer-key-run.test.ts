/**
 * The answer-key runner (S46): the committed run reproduces from the committed bodies, the SQL it
 * writes is safe to run twice, and the whole thing is off the stamp path.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSeed, runSeed, toSql } from '../scripts/answer-key/run';
import type { FetchLike } from '../src/answer-key/types';

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'eval/answer-key');
const seed = parseSeed(readFileSync(join(DIR, 'seed-2026-10-06.jsonl'), 'utf8'));
const relay = JSON.parse(readFileSync(join(DIR, 'relay-2026-10-06.json'), 'utf8'));
const committed = readFileSync(join(DIR, 'run-2026-10-06.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as { seed: string; outcome: string });

const offline: FetchLike = async () => {
  throw Object.assign(new Error('offline'), { name: 'TypeError' });
};

describe('the 2026-10-06 run', () => {
  it('every Wikidata row reproduces offline from the committed bodies', async () => {
    const wd = seed.filter((s) => s.spec.kind === 'wikidata');
    const rows = await runSeed(wd, offline, relay, {});
    for (const r of rows) expect(r.outcome).toBe(committed.find((c) => c.seed === r.seed)!.outcome);
    expect(rows.every((r) => r.relayed.length === 2)).toBe(true);
  });

  it('without the network, npm and PyPI rows are unchecked, never a verdict', async () => {
    const rows = await runSeed(seed.filter((s) => s.spec.kind !== 'wikidata'), offline, {}, {});
    expect(rows.every((r) => r.outcome === 'unchecked')).toBe(true);
  });

  it('the committed run has all three outcomes, and its counts are what the record says', () => {
    const count = (o: string) => committed.filter((c) => c.outcome === o).length;
    expect([count('supports'), count('contradicts'), count('unchecked')]).toEqual([5, 6, 3]);
    expect(committed).toHaveLength(seed.length);
  });
});

describe('the 2026-10-06 arXiv run (second slice)', () => {
  const axSeed = parseSeed(readFileSync(join(DIR, 'seed-arxiv-2026-10-06.jsonl'), 'utf8'));
  const axRelay = JSON.parse(readFileSync(join(DIR, 'relay-arxiv-2026-10-06.json'), 'utf8'));
  const axRun = readFileSync(join(DIR, 'run-arxiv-2026-10-06.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { seed: string; outcome: string; reason: string });

  it('every row reproduces offline from the committed feeds, outcome and reason', async () => {
    const rows = await runSeed(axSeed, offline, axRelay, {});
    for (const r of rows) {
      const c = axRun.find((x) => x.seed === r.seed)!;
      expect([r.outcome, r.reason]).toEqual([c.outcome, c.reason]);
    }
    expect(rows.every((r) => r.relayed.length === 1)).toBe(true);
  });

  it('its counts are what the records say: 3 supports, 2 contradicts, 2 unchecked', () => {
    const count = (o: string) => axRun.filter((c) => c.outcome === o).length;
    expect([count('supports'), count('contradicts'), count('unchecked')]).toEqual([3, 2, 2]);
    expect(axRun).toHaveLength(axSeed.length);
  });
});

describe('parseSeed', () => {
  it('refuses a row without id, claim or spec', () => {
    expect(() => parseSeed('{"id":"x","claim":"y"}')).toThrow(/seed line 1/);
  });
});

describe('toSql', () => {
  const s = [{ id: "o'brien", claim: "It's a claim.", spec: { kind: 'npm-package' as const, name: 'x', asserts: 'exists' as const } }];
  const rows = [{ seed: "o'brien", claim: "It's a claim.", outcome: 'unchecked' as const, reason: "the registry's answer was 503", checker: 'npm-registry@1', relayed: [] }];
  const sql = toSql(s, rows, 'run-x', '2026-10-06T00:00:00Z');

  it('escapes quotes, and is idempotent by seed, locator and run', () => {
    expect(sql).toContain("'o''brien'");
    expect(sql).toContain("'It''s a claim.'");
    expect(sql).toContain('on conflict (seed_id) do nothing');
    expect(sql).toContain("where not exists (select 1 from public.ak_checks where run_id = 'run-x'");
  });

  it('a new run supersedes the current check of the same claim and checker from an earlier run', () => {
    expect(sql).toContain("c.run_id <> 'run-x' and not exists (select 1 from public.ak_checks n where n.supersedes = c.id)");
  });

  it('an unchecked row with no record inserts a null record, which the table allows only for unchecked', () => {
    expect(sql).toMatch(/select \(select id from public\.ak_claims where seed_id = 'o''brien'\), null,/);
  });
});

describe('off the stamp path', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('nothing in src outside src/answer-key imports it', () => {
    const importers = files(join(ROOT, 'src'))
      .filter((f) => !f.includes(`${join('src', 'answer-key')}`))
      .filter((f) => /answer-key/.test(readFileSync(f, 'utf8')));
    expect(importers).toEqual([]);
  });
});
