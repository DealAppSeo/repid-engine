/**
 * The answer key's history (S46): a DAG by construction. Claims and records are joined only by
 * checks, and the only other link, `supersedes`, points strictly back in time at a check of the same
 * claim, once. Nothing is deleted: a later check replaces an earlier one by superseding it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphError, assertHistory, claimStatuses, currentChecks, statusOf, summarize, type CheckRow } from '../src/answer-key/graph';

const row = (id: string, claimId: string, outcome: CheckRow['outcome'], at: string, supersedes?: string, checker = 'npm-registry@1'): CheckRow => ({
  id,
  claimId,
  checker,
  outcome,
  checkedAt: at,
  ...(supersedes ? { supersedes } : {}),
});

describe('history must be a DAG of the allowed shape', () => {
  it('accepts a chain of replacements, each pointing back in time', () => {
    expect(() =>
      assertHistory([row('a', 'c1', 'unchecked', '2026-10-01T00:00:00Z'), row('b', 'c1', 'supports', '2026-10-02T00:00:00Z', 'a'), row('c', 'c1', 'contradicts', '2026-10-03T00:00:00Z', 'b')]),
    ).not.toThrow();
  });

  it.each([
    ['a missing target', [row('b', 'c1', 'supports', '2026-10-02T00:00:00Z', 'zzz')], /does not exist/],
    ['another claim', [row('a', 'c2', 'supports', '2026-10-01T00:00:00Z'), row('b', 'c1', 'supports', '2026-10-02T00:00:00Z', 'a')], /another claim/],
    ['the same instant', [row('a', 'c1', 'supports', '2026-10-01T00:00:00Z'), row('b', 'c1', 'supports', '2026-10-01T00:00:00Z', 'a')], /not earlier/],
    ['a cycle (each supersedes the other)', [row('a', 'c1', 'supports', '2026-10-01T00:00:00Z', 'b'), row('b', 'c1', 'supports', '2026-10-02T00:00:00Z', 'a')], /not earlier/],
    ['a fork', [row('a', 'c1', 'supports', '2026-10-01T00:00:00Z'), row('b', 'c1', 'supports', '2026-10-02T00:00:00Z', 'a'), row('c', 'c1', 'supports', '2026-10-03T00:00:00Z', 'a')], /superseded twice/],
    ['a duplicate id', [row('a', 'c1', 'supports', '2026-10-01T00:00:00Z'), row('a', 'c1', 'supports', '2026-10-02T00:00:00Z')], /share one id/],
  ] as const)('refuses %s', (_name, rows, msg) => {
    expect(() => assertHistory(rows as unknown as CheckRow[])).toThrow(GraphError);
    expect(() => assertHistory(rows as unknown as CheckRow[])).toThrow(msg);
  });
});

describe('status comes from current checks only', () => {
  it('a later Caught replaces an earlier pass: the claim is contradicted, and the old check is kept', () => {
    const rows = [row('a', 'c1', 'supports', '2026-10-01T00:00:00Z'), row('b', 'c1', 'contradicts', '2026-10-02T00:00:00Z', 'a')];
    expect(currentChecks(rows).map((r) => r.id)).toEqual(['b']);
    expect(claimStatuses(rows).get('c1')).toBe('contradicted');
    expect(rows).toHaveLength(2);
  });

  it('two current checks that disagree are conflicted: neither wins', () => {
    expect(statusOf([row('a', 'c1', 'supports', 't'), row('b', 'c1', 'contradicts', 't', undefined, 'wikidata-entity@1')])).toBe('conflicted');
  });

  it('unchecked never becomes a verdict, alone or beside one', () => {
    expect(statusOf([row('a', 'c1', 'unchecked', 't')])).toBe('unchecked');
    expect(statusOf([row('a', 'c1', 'unchecked', 't'), row('b', 'c1', 'supports', 't', undefined, 'x@1')])).toBe('supported');
    expect(statusOf([])).toBe('unchecked');
  });

  it('a claim whose only check was superseded by an unchecked one goes back to unchecked', () => {
    const rows = [row('a', 'c1', 'supports', '2026-10-01T00:00:00Z'), row('b', 'c1', 'unchecked', '2026-10-02T00:00:00Z', 'a')];
    expect(claimStatuses(rows).get('c1')).toBe('unchecked');
  });
});

describe('summaries are counts over a stated window, with no rate under the floor', () => {
  it('14 claims is counts only', () => {
    const s = summarize(['supported', 'contradicted', 'unchecked'], { from: '2026-10-06', to: '2026-10-06' });
    expect(s).toMatchObject({ total: 3, decided: 2, decidedShare: null, window: { from: '2026-10-06', to: '2026-10-06' } });
  });
  it('at the floor a share appears', () => {
    const statuses = Array.from({ length: 100 }, (_, i) => (i < 90 ? 'supported' : 'unchecked') as const);
    expect(summarize(statuses, { from: 'a', to: 'b' }, 90).decidedShare).toBeCloseTo(0.9, 6);
  });
});

describe('the migration enforces the same rules in the database', () => {
  const sql = readFileSync(join(__dirname, '../supabase/migrations/20261006160000_answer_key_graph.sql'), 'utf8');

  it('three outcomes, a verdict always names its record, one supersede per check', () => {
    expect(sql).toContain("check (outcome in ('supports', 'contradicts', 'unchecked'))");
    expect(sql).toContain("check (outcome = 'unchecked' or record_id is not null)");
    expect(sql).toMatch(/supersedes\s+bigint\s+unique references public\.ak_checks \(id\)/);
  });

  it('append-only, and a supersede must be an earlier check of the same claim', () => {
    expect(sql).toContain('before insert or update or delete on public.ak_checks');
    expect(sql).toContain('a check may only supersede a check of the same claim');
    expect(sql).toContain('a check may only supersede an earlier one (no cycles)');
  });

  it('nothing public: RLS on, every privilege revoked from anon and authenticated', () => {
    for (const t of ['ak_claims', 'ak_records', 'ak_checks']) expect(sql).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security;`));
    expect(sql).toMatch(/revoke all on public\.ak_claims, public\.ak_records, public\.ak_checks, public\.ak_claim_status\s+from anon, authenticated;/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toContain('with (security_invoker = true)');
  });

  it('claims are ours: curated or from the ledger, never a user\'s text', () => {
    expect(sql).toContain("source         text        not null check (source in ('curated', 'ledger'))");
  });
});

describe('the arXiv migration widens the record kinds and nothing else', () => {
  const sql = readFileSync(join(__dirname, '../supabase/migrations/20261006170000_answer_key_arxiv.sql'), 'utf8');
  const statements = sql
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);

  it('two statements, both on the one kind check', () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe('alter table public.ak_records drop constraint ak_records_kind_check');
    expect(statements[1]).toMatch(/^alter table public\.ak_records\s+add constraint ak_records_kind_check check \(kind in \('npm', 'pypi', 'wikidata', 'claimreview', 'arxiv'\)\)$/);
  });

  it('sorts after the migration that creates ak_records', () => {
    expect('20261006170000_answer_key_arxiv.sql' > '20261006160000_answer_key_graph.sql').toBe(true);
  });
});
