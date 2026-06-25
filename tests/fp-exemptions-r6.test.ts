/**
 * R6 Phase 2 — principle-based FP exemptions, EACH paired with an attack proving it can't be
 * weaponized. The principle: CONTEXT determines consequence (a doc / test / fixture write is
 * reversible context, not an executable action). The exemption only avoids the FAIL-SAFE; any
 * positive T2 rule still DOMINATES (max-severity), so it never bypasses detection of a real action.
 */
import { classifyAction } from '../src/services/consequence-classifier';

const ids = (a: any) => classifyAction(a).hits.map((h) => h.ruleId);

describe('FP exemption: docs (.md/.txt/...) — and its paired attack', () => {
  it('EXEMPT: writing README.md is T0, not a fail-safe T2 over-block', () => {
    const r = classifyAction({ kind: 'file_write', paths: ['README.md'] });
    expect(r.tier).toBe('T0');
    expect(r.hits.map((h) => h.ruleId)).toContain('T0_NONEXEC_CONTEXT');
  });
  it('ATTACK: a "doc" inside migrations/ is STILL T2 (critical path dominates the exemption)', () => {
    expect(classifyAction({ kind: 'file_write', paths: ['migrations/evil.md'] }).tier).toBe('T2');
  });
  it('ATTACK: a real DDL action is untouched by the doc exemption → T2', () => {
    expect(ids({ kind: 'db', sql: 'DROP TABLE repid_agents' })).toContain('T2_DDL');
  });
});

describe('FP exemption: test/fixture paths — and its paired attack', () => {
  it('EXEMPT: writing src/foo.test.ts is T0', () => {
    expect(classifyAction({ kind: 'file_write', paths: ['src/foo.test.ts'] }).tier).toBe('T0');
  });
  it('EXEMPT: writing tests/fixtures/sample.json is T0', () => {
    expect(classifyAction({ kind: 'file_write', paths: ['tests/fixtures/sample.json'] }).tier).toBe('T0');
  });
  it('ATTACK: a migration smuggled under a tests/ path is STILL T2 (critical dominates)', () => {
    expect(classifyAction({ kind: 'file_write', paths: ['tests/migrations/2026-wipe.sql'] }).tier).toBe('T2');
  });
  it('ATTACK: an .env smuggled under tests/ is STILL T2', () => {
    expect(classifyAction({ kind: 'file_write', paths: ['tests/.env.production'] }).tier).toBe('T2');
  });
});

describe('FP exemption: SQL comment context — and its paired attack', () => {
  it('EXEMPT: a commented-out DROP does NOT trigger the DDL rule (it is not executed)', () => {
    expect(ids({ kind: 'db', sql: '/* DROP TABLE x */ SELECT 1' })).not.toContain('T2_DDL');
    expect(ids({ kind: 'db', sql: '-- DROP TABLE x\nSELECT count(*) FROM t' })).not.toContain('T2_DDL');
  });
  it('ATTACK: a REAL DROP with a trailing comment IS still caught → T2_DDL', () => {
    expect(ids({ kind: 'db', sql: 'DROP TABLE x -- harmless note' })).toContain('T2_DDL');
  });
});

describe('exemption never overrides a positive rule (dominance invariant)', () => {
  it('a mixed write (doc + a source file) is NOT downgraded — source still fail-safes', () => {
    // Not ALL paths are non-exec → no T0_NONEXEC hit → src file still fail-safes to T2.
    const r = classifyAction({ kind: 'file_write', paths: ['README.md', 'src/index.ts'] });
    expect(r.hits.map((h) => h.ruleId)).not.toContain('T0_NONEXEC_CONTEXT');
    expect(r.tier).toBe('T2');
  });
  it('prod project id in a doc-path write still floors to T2 via text scan', () => {
    expect(classifyAction({ kind: 'file_write', paths: ['docs/notes.md'], description: 'config for qnnpjhlxljtqyigedwkb' }).tier).toBe('T2');
  });
});
