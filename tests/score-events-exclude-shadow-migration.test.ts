/**
 * 20261102120000_score_events_exclude_shadow: every view or function it redefines that reads
 * repid_score_events carries an is_shadow predicate per read, and the rollback restores each one
 * with the same header (view options, function signature and attributes).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'supabase', 'migrations');
const read = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
const forward = read('20261102120000_score_events_exclude_shadow.sql');
const rollback = read('20261102120000_score_events_exclude_shadow.rollback.sql');

type Stmt = { name: string; header: string; sql: string };
const statements = (src: string): Map<string, Stmt> =>
  new Map(
    src
      .split(/^(?=CREATE OR REPLACE (?:VIEW|FUNCTION) )/m)
      .slice(1)
      .map((sql) => {
        const kindName = sql.match(/^CREATE OR REPLACE (VIEW|FUNCTION) public\.(\w+)/)!;
        const header = kindName[1] === 'VIEW' ? sql.slice(0, sql.indexOf(' AS\n')) : sql.slice(0, sql.indexOf('AS $function$'));
        return [`${kindName[1]} ${kindName[2]}`, { name: kindName[2], header, sql }];
      }),
  );

const fwd = statements(forward);
const back = statements(rollback);
const reads = (sql: string) => (sql.match(/\b(?:FROM|JOIN)[\s(]+(?:public\.)?repid_score_events\b/gi) ?? []).length;
const predicates = (sql: string) => (sql.match(/\bis_shadow = false\b/g) ?? []).length;

describe('score-event readers exclude shadow rows', () => {
  it('redefines the 16 views and 11 functions, in one transaction', () => {
    expect([...fwd.keys()].filter((k) => k.startsWith('VIEW'))).toHaveLength(16);
    expect([...fwd.keys()].filter((k) => k.startsWith('FUNCTION'))).toHaveLength(11);
    for (const src of [forward, rollback]) {
      expect(src).toMatch(/^BEGIN;$/m);
      expect(src.trimEnd()).toMatch(/\nCOMMIT;$/);
    }
  });

  it.each([...fwd.values()].map((s) => [s.name, s] as const))('%s: one is_shadow predicate per read of repid_score_events', (_n, s) => {
    expect(reads(s.sql)).toBeGreaterThan(0);
    expect(predicates(s.sql)).toBeGreaterThanOrEqual(reads(s.sql));
  });

  it('the rollback has a matching definition for every changed object, and only those', () => {
    expect([...back.keys()].sort()).toEqual([...fwd.keys()].sort());
  });

  it.each([...fwd.entries()].map(([k, s]) => [k, s] as const))('%s: rollback keeps the header and drops the predicate', (k, s) => {
    const old = back.get(k)!;
    expect(old.header).toBe(s.header); // WITH (security_invoker=...) / signature, volatility, SECURITY DEFINER, SET
    expect(predicates(old.sql)).toBe(0);
    expect(reads(old.sql)).toBe(reads(s.sql));
  });
});
