import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditDay, beaconFlagProblem, dayPopulation, drandRoundAfter, drawSample, DRAND_QUICKNET } from '../scripts/t12/audit-run';

const SQL_DIR = join(__dirname, '..', 'ops', 't12', 'audit');
const WRITE = /\b(insert|update|delete|merge|upsert|drop|alter|create|grant|revoke|truncate|comment\s+on|copy|call|do)\b/i;
// `update` and friends also appear inside comments and as words like "updated_at"; strip comments and
// match whole words only. A string literal could still hide one; these files have none that do.
const code = (sql: string) => sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const writesIn = (sql: string) => WRITE.test(code(sql));

describe('T12 audit v0 is read-only', () => {
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));

  it('finds the audit SQL files', () => {
    expect(files.sort()).toEqual(['capability-record.sql', 'live-repid-independence.sql', 'role-migration-prod-compat.sql']);
  });

  it.each(files)('%s contains no write or DDL statement', (f) => {
    expect(writesIn(readFileSync(join(SQL_DIR, f), 'utf8'))).toBe(false);
  });

  it('the write check catches a write (positive control)', () => {
    expect(writesIn('select 1; insert into trinity_tasks (title) values (1)')).toBe(true);
    expect(writesIn('-- update in a comment only\nselect updated_at from t')).toBe(false);
  });

  it('the runner reads inside a read-only transaction and rolls it back', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 't12', 'audit-run.ts'), 'utf8');
    expect(src).toContain("db.query('BEGIN READ ONLY')");
    expect(src).toContain("db.query('ROLLBACK')");
  });

  // Strix on #1531: the agent writes its own confidence, so the parse must not let it hide or crash the audit.
  it('parses confidence defensively: bounded capture, and a missing value stays NULL', () => {
    const sql = code(readFileSync(join(SQL_DIR, 'capability-record.sql'), 'utf8'));
    expect(sql).not.toMatch(/least\(greatest\(nullif\(/); // clamping a NULL turns it into 0
    expect(sql).not.toMatch(/"confidence"[^']*\[0-9\]\*/); // unbounded digits can overflow numeric
    expect(sql).toMatch(/"confidence"[^']*\[0-9\]\{1,3\}/);
    expect(sql).toContain('case when conf_raw is null then null');
    expect(sql).toContain('coalesce(conf, 1) >= 0.8');
  });
});

describe('drawSample', () => {
  const pool = Array.from({ length: 14 }, (_, i) => i);

  it('is reproducible from its seed', () => {
    expect(drawSample(pool, 'audit-2026-11-10')).toEqual(drawSample(pool, 'audit-2026-11-10'));
    // The first hand run (2026-11-10) drew index 3 of 14 with this seed.
    expect(drawSample(pool, 'audit-2026-11-10')?.index).toBe(3);
  });

  it('stays in range and returns null for an empty pool', () => {
    for (const s of ['a', 'b', 'c', 'd']) {
      const d = drawSample(pool, s)!;
      expect(d.index).toBeGreaterThanOrEqual(0);
      expect(d.index).toBeLessThan(14);
      expect(d.entry).toBe(pool[d.index]);
    }
    expect(drawSample([], 'x')).toBeNull();
  });
});

describe('the beacon draw cannot be predicted before the population closes', () => {
  // Round 33853811 was fetched live on 2026-11-11; its time follows from genesis + (round - 1) * period.
  const known = 33853811;
  const knownAt = (DRAND_QUICKNET.genesis + (known - 1) * DRAND_QUICKNET.period) * 1000;

  it('picks the first round strictly after the cutoff, never one at or before it', () => {
    for (const cutoff of [knownAt - 1, knownAt, knownAt + 1, knownAt + 2999, knownAt + 3000]) {
      const { round, atMs } = drandRoundAfter(cutoff);
      expect(atMs).toBeGreaterThan(cutoff);
      expect(atMs - DRAND_QUICKNET.period * 1000).toBeLessThanOrEqual(cutoff);
      expect(atMs).toBe((DRAND_QUICKNET.genesis + (round - 1) * DRAND_QUICKNET.period) * 1000);
    }
    expect(drandRoundAfter(knownAt - 1).round).toBe(known);
    expect(drandRoundAfter(knownAt).round).toBe(known + 1);
  });

  it('draws from exactly one UTC day, by time, not by string', () => {
    const w = auditDay('2026-11-10')!;
    expect(w.endMs - w.startMs).toBe(24 * 60 * 60 * 1000 - 1);
    const entries = [
      { ts: '2026-11-09T23:59:59.999Z' },
      { ts: '2026-11-10T00:00:00Z' },
      { ts: '2026-11-10T23:59:59Z' },
      { ts: '2026-11-11T00:00:00Z' },
      { ts: 'not a time' },
    ];
    expect(dayPopulation(entries, w).map((e) => e.ts)).toEqual(['2026-11-10T00:00:00Z', '2026-11-10T23:59:59Z']);
  });

  it('accepts only a real date, so a day cannot be bent into a free window', () => {
    for (const bad of ['2026-11-31', '2026-13-01', '2026-11-10T12:00:00Z', '', '2026-1-10']) expect(auditDay(bad)).toBeNull();
    expect(drandRoundAfter(auditDay('2026-11-10')!.endMs).atMs).toBeGreaterThan(auditDay('2026-11-10')!.endMs);
  });

  it('a beacon asked for never falls back to the fixed seed', () => {
    const base = ['node', 'audit-run.ts', '--out', 'x'];
    expect(beaconFlagProblem([...base, '--beacon', 'drand', '--day', '2026-11-10'])).toBeNull();
    expect(beaconFlagProblem(base)).toBeNull();
    expect(beaconFlagProblem([...base, '--beacon', 'Drand', '--day', '2026-11-10'])).toContain('must be drand');
    expect(beaconFlagProblem([...base, '--day', '2026-11-10', '--beacon'])).toContain('got nothing');
    expect(beaconFlagProblem([...base, '--day', '2026-11-10'])).toContain('only for --beacon drand');
    // `=` forms are unknown tokens to this parser, so without a refusal they would be silently ignored.
    expect(beaconFlagProblem([...base, '--beacon=drand', '--day', '2026-11-10'])).toContain('separate words');
    expect(beaconFlagProblem([...base, '--beacon', 'drand', '--day=2026-11-10'])).toContain('separate words');
    // A repeated --day would let the later value win unseen.
    expect(beaconFlagProblem([...base, '--beacon', 'drand', '--day', '2026-11-10', '--day', '2026-11-09'])).toContain('once');
  });

  it('the runner refuses a free start or seed alongside the beacon', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 't12', 'audit-run.ts'), 'utf8');
    expect(src).toContain("if (since || arg('seed')) throw new Error");
    expect(src).not.toMatch(/arg\('cutoff'\)/);
  });
});
