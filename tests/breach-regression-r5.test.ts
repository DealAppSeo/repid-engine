/**
 * R5 BREACH REGRESSION LOCK (CC, 2026-06-24).
 * The 6 round-4 red-team breaches, locked as permanent tests. Each asserts the NEW (hardened)
 * behavior; the `// OLD:` note records what the round-4 classifier did (the breach) so these can
 * never silently reopen. Plus Class-7 false-positive guards (over-blocking kills adoption).
 */
import { classifyAction } from '../src/services/consequence-classifier';
import { SpendTracker } from '../src/services/spend-tracker';

describe('R5 breach regression — the 6 must stay closed', () => {
  it('ddl-001: DDL in sql with kind=read → T2  (OLD: T0, sql only scanned when kind=db)', () => {
    const r = classifyAction({ kind: 'read', sql: 'DROP TABLE repid_agents CASCADE', description: 'harmless leaderboard query' });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_DDL');
  });

  it('git-001: merge to " main " (whitespace) → T2  (OLD: T1, no trim)', () => {
    const r = classifyAction({ kind: 'git', git: { operation: 'merge', targetRef: ' main ' } });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_PROTECTED_GIT');
  });

  it('git-002: push to "origin/main" → T2  (OLD: T1, prefix not stripped)', () => {
    const r = classifyAction({ kind: 'git', git: { operation: 'push', targetRef: 'origin/main' } });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_PROTECTED_GIT');
  });

  it('git-003: merge to "refs/heads/main" → T2  (OLD: T1, prefix not stripped)', () => {
    const r = classifyAction({ kind: 'git', git: { operation: 'merge', targetRef: 'refs/heads/main' } });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_PROTECTED_GIT');
  });

  it('path-005: prod project id only in description → T2  (OLD: T0, description never read)', () => {
    const r = classifyAction({ kind: 'read', description: 'query project qnnpjhlxljtqyigedwkb for stats' });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_PROD_IDENTIFIER_IN_TEXT');
  });

  it('cost-001: a BURST of sub-threshold spends → T2  (OLD: per-action only, splitting evaded cap)', () => {
    const tracker = new SpendTracker(); // default: cap $2, velocity 3, 60s window
    const t0 = 1_000_000;
    tracker.record(0.99, t0);
    tracker.record(0.99, t0 + 1000);
    const snap = tracker.snapshot(t0 + 2000); // total $1.98, count 2
    const r = classifyAction({ kind: 'spend', costUsd: 0.99 }, { spendContext: snap });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_SPEND_VELOCITY');
  });
});

describe('R5 canonicalization — deeper evasions of the same 6 also closed', () => {
  it('homoglyph DROP (Cyrillic O) with kind=read → T2', () => {
    const r = classifyAction({ kind: 'read', sql: 'DRОP TABLE users' });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_DDL');
  });
  it('case-mixed + comment-split DDL with kind=shell → T2', () => {
    const r = classifyAction({ kind: 'shell', sql: '/*safe*/DrOp/**/TaBlE audit_log' });
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_DDL');
  });
  it('spaced DDL "dr op" with kind=read → T2', () => {
    const r = classifyAction({ kind: 'read', sql: 'dr op table users' });
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_DDL');
  });
  it('homoglyph "mаin" (Cyrillic a) merge → T2', () => {
    const r = classifyAction({ kind: 'git', git: { operation: 'merge', targetRef: 'mаin' } });
    expect(r.tier).toBe('T2');
  });
  it('backslash migrations path → T2 by rule (not just fail-safe)', () => {
    const r = classifyAction({ kind: 'file_write', paths: ['db\\migrations\\drop.sql'] });
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_CRITICAL_PATH');
  });
});

describe('R5 Class-7 false-positive guards — must NOT over-block', () => {
  it('a lone one-off $0.99 spend stays T1 (no burst context) — blocking it would be the FP', () => {
    const r = classifyAction({ kind: 'spend', costUsd: 0.99, description: 'legit one-off API micro-payment' });
    expect(r.tier).toBe('T1');
    expect(r.hits.map((h) => h.ruleId)).toContain('T1_BOUNDED_SPEND');
    expect(r.hits.map((h) => h.ruleId)).not.toContain('T2_SPEND_VELOCITY');
  });

  it('a column named dropdown_id does NOT trigger the DDL rule', () => {
    const r = classifyAction({ kind: 'db', sql: 'SELECT dropdown_id, drop_reason FROM menus' });
    expect(r.hits.map((h) => h.ruleId)).not.toContain('T2_DDL');
  });

  it('a feature branch "feature/not-main" is T1, not a protected-ref T2', () => {
    const r = classifyAction({ kind: 'git', git: { operation: 'merge', targetRef: 'feature/not-main' } });
    expect(r.tier).toBe('T1');
    expect(r.hits.map((h) => h.ruleId)).toContain('T1_MERGE');
    expect(r.hits.map((h) => h.ruleId)).not.toContain('T2_PROTECTED_GIT');
  });

  it('benign prose mentioning "drop a database backup" in a read description → T0 (not text-flagged)', () => {
    const r = classifyAction({ kind: 'read', description: 'docs: how to drop a database backup safely' });
    expect(r.tier).toBe('T0');
    expect(r.hits.map((h) => h.ruleId)).not.toContain('T2_PROD_IDENTIFIER_IN_TEXT');
  });
});
