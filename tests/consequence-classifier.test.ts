/**
 * Tests for the consequence classifier + shadow gate (spec v0.3 §3, dry-run).
 * Proves the two safety-critical invariants explicitly:
 *   1. Any unmatched action → T2 (fail-to-HITL), never fail-open. [LOCK A4]
 *   2. An LLM suggestion can never downgrade below the deterministic rule floor. [LOCK A5]
 */

import {
  Action,
  classifyAction,
  evaluateRules,
  ruleFloor,
  maxTier,
  DEFAULT_CONFIG,
  Tier,
} from '../src/services/consequence-classifier';
import {
  consequenceGate,
  shadowClassify,
  wouldRouteFor,
  ShadowRecord,
  ShadowSink,
} from '../src/middleware/consequence-gate';

describe('maxTier — severity ordering', () => {
  it('returns the more-severe tier', () => {
    expect(maxTier('T0', 'T2')).toBe('T2');
    expect(maxTier('T2', 'T0')).toBe('T2');
    expect(maxTier('T1', 'T0')).toBe('T1');
    expect(maxTier('T0', 'T0')).toBe('T0');
    expect(maxTier('T1', 'T2')).toBe('T2');
  });
});

describe('T2 — deterministic critical allowlist [LOCK A5]', () => {
  it('prod project id → T2', () => {
    const r = classifyAction({ kind: 'db', projectId: 'qnnpjhlxljtqyigedwkb', sql: 'select 1' });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_PROD_PROJECT');
  });

  it.each([
    ['migrations/2026-06-24.sql'],
    ['src/.env'],
    ['.env.local'],
    ['config/keymap.json'],
    ['secrets/key.txt'],
    ['deploy/server.pem'],
    ['governance/policy.yaml'],
  ])('critical path %s → T2', (p) => {
    const r = classifyAction({ kind: 'file_write', paths: [p] });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_CRITICAL_PATH');
  });

  it.each([['ALTER TABLE x'], ['drop table y'], ['CREATE INDEX z'], ['truncate w'], ['GRANT ALL'], ['revoke select']])(
    'DDL %s → T2',
    (sql) => {
      const r = classifyAction({ kind: 'db', sql });
      expect(r.tier).toBe('T2');
      expect(r.hits.map((h) => h.ruleId)).toContain('T2_DDL');
    },
  );

  it.each([['main'], ['master'], ['production'], ['prod'], ['release']])('git push/merge to %s → T2', (ref) => {
    const push = classifyAction({ kind: 'git', git: { operation: 'push', targetRef: ref } });
    const merge = classifyAction({ kind: 'git', git: { operation: 'merge', targetRef: ref } });
    expect(push.tier).toBe('T2');
    expect(merge.tier).toBe('T2');
    expect(push.hits.map((h) => h.ruleId)).toContain('T2_PROTECTED_GIT');
  });

  it('secret rotation → T2', () => {
    expect(classifyAction({ kind: 'secret' }).tier).toBe('T2');
  });

  it('prod platform mutation → T2', () => {
    const r = classifyAction({ kind: 'platform', platform: { name: 'railway', isProd: true } });
    expect(r.tier).toBe('T2');
    expect(r.hits.map((h) => h.ruleId)).toContain('T2_PLATFORM_PROD');
  });

  it('cost ≥ threshold → T2', () => {
    expect(classifyAction({ kind: 'spend', costUsd: 1.0 }).tier).toBe('T2');
    expect(classifyAction({ kind: 'spend', costUsd: 50 }).tier).toBe('T2');
  });
});

describe('T1 — consequential but bounded', () => {
  it('merge to feature branch → T1', () => {
    const r = classifyAction({ kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' } });
    expect(r.tier).toBe('T1');
    expect(r.hits.map((h) => h.ruleId)).toContain('T1_MERGE');
  });

  it('non-prod platform config → T1', () => {
    const r = classifyAction({ kind: 'platform', platform: { name: 'vercel-preview', isProd: false } });
    expect(r.tier).toBe('T1');
  });

  it('bounded spend (0 < cost < threshold) → T1', () => {
    const r = classifyAction({ kind: 'spend', costUsd: 0.25 });
    expect(r.tier).toBe('T1');
    expect(r.hits.map((h) => h.ruleId)).toContain('T1_BOUNDED_SPEND');
  });

  it('push to feature branch → T1', () => {
    const r = classifyAction({ kind: 'git', git: { operation: 'push', targetRef: 'feat/cc' } });
    expect(r.tier).toBe('T1');
    expect(r.hits.map((h) => h.ruleId)).toContain('T1_FEATURE_PUSH');
  });
});

describe('T0 — trivial / reversible', () => {
  it('pure read → T0', () => {
    expect(classifyAction({ kind: 'read' }).tier).toBe('T0');
  });
  it('local-only file write → T0', () => {
    const r = classifyAction({ kind: 'file_write', paths: ['scratch/notes.txt'], localOnly: true });
    expect(r.tier).toBe('T0');
    expect(r.failSafe).toBe(false);
  });
});

describe('[LOCK A4] unmatched action → T2 fail-safe', () => {
  it('empty/unknown action → T2 with failSafe flag', () => {
    const r = classifyAction({ kind: 'totally_unknown_kind' });
    expect(r.tier).toBe('T2');
    expect(r.ruleFloor).toBe('T2');
    expect(r.failSafe).toBe(true);
    expect(r.hits).toHaveLength(0);
  });

  it('file write to a non-local, non-critical path with no localOnly flag → T2 (no rule matched)', () => {
    // Not marked localOnly, not a critical path → matches NOTHING → fail-safe T2.
    const r = classifyAction({ kind: 'file_write', paths: ['src/foo.ts'] });
    expect(r.tier).toBe('T2');
    expect(r.failSafe).toBe(true);
  });

  it('ruleFloor() on zero hits is T2 fail-safe', () => {
    expect(ruleFloor([])).toEqual({ tier: 'T2', failSafe: true });
  });
});

describe('[LOCK A5 no-downgrade] LLM may never lower the rule floor', () => {
  const downgradeToT0 = () => 'T0' as Tier;
  const downgradeToT1 = () => 'T1' as Tier;
  const escalateToT2 = () => 'T2' as Tier;

  it('LLM "T0" suggestion on a T2 floor stays T2', () => {
    const action: Action = { kind: 'db', sql: 'DROP TABLE repid_agents' };
    const r = classifyAction(action, { llmSuggest: downgradeToT0 });
    expect(r.ruleFloor).toBe('T2');
    expect(r.llmSuggested).toBe('T0');
    expect(r.tier).toBe('T2'); // floor wins
  });

  it('LLM "T0" suggestion on the fail-safe (unmatched→T2) floor stays T2', () => {
    const r = classifyAction({ kind: 'mystery' }, { llmSuggest: downgradeToT0 });
    expect(r.failSafe).toBe(true);
    expect(r.tier).toBe('T2');
  });

  it('LLM "T1" suggestion cannot lower a T2 protected-git push', () => {
    const r = classifyAction(
      { kind: 'git', git: { operation: 'push', targetRef: 'main' } },
      { llmSuggest: downgradeToT1 },
    );
    expect(r.tier).toBe('T2');
  });

  it('LLM CAN escalate a T0 read to T2 (only direction allowed)', () => {
    const r = classifyAction({ kind: 'read' }, { llmSuggest: escalateToT2 });
    expect(r.ruleFloor).toBe('T0');
    expect(r.tier).toBe('T2');
  });

  it('no LLM hook → tier equals the deterministic floor', () => {
    const r = classifyAction({ kind: 'read' });
    expect(r.llmSuggested).toBeNull();
    expect(r.tier).toBe(r.ruleFloor);
  });
});

describe('max-severity across multiple hits', () => {
  it('a T2 hit dominates co-occurring T1/T0 hits', () => {
    // push to main (T2_PROTECTED_GIT) — single dominant hit.
    const r = classifyAction({ kind: 'git', git: { operation: 'push', targetRef: 'main' } });
    expect(r.tier).toBe('T2');
  });

  it('migrations path + db DDL → still T2 (multiple T2 hits)', () => {
    const r = classifyAction({ kind: 'db', sql: 'ALTER TABLE t', paths: ['migrations/x.sql'] });
    expect(r.tier).toBe('T2');
    const ids = r.hits.map((h) => h.ruleId);
    expect(ids).toContain('T2_DDL');
    expect(ids).toContain('T2_CRITICAL_PATH');
  });
});

describe('shadow gate — local-only, enforces nothing', () => {
  function mockReqRes() {
    const req: any = { method: 'POST', path: '/api/v1/thing', url: '/api/v1/thing' };
    const res: any = {};
    return { req, res };
  }

  it('off mode → pure pass-through, no sink call', () => {
    process.env.CONSEQUENCE_GATE_MODE = 'off';
    const records: ShadowRecord[] = [];
    const sink: ShadowSink = (r) => { records.push(r); };
    const mw = consequenceGate({ sink, deriveAction: () => ({ kind: 'read' }) });
    const { req, res } = mockReqRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(records).toHaveLength(0);
    delete process.env.CONSEQUENCE_GATE_MODE;
  });

  it('shadow mode → always calls next() (never blocks), logs to injected in-memory sink', () => {
    process.env.CONSEQUENCE_GATE_MODE = 'shadow';
    const records: ShadowRecord[] = [];
    const sink: ShadowSink = (r) => { records.push(r); };
    const mw = consequenceGate({
      sink,
      deriveAction: () => ({ kind: 'db', sql: 'DROP TABLE x' }),
    });
    const { req, res } = mockReqRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true); // enforces nothing
    expect(records).toHaveLength(1);
    expect(records[0]!.classification!.tier).toBe('T2');
    expect(records[0]!.wouldRoute).toBe('HITL');
    delete process.env.CONSEQUENCE_GATE_MODE;
  });

  it('null-derived action → no classification, wouldRoute no-action, still next()', () => {
    process.env.CONSEQUENCE_GATE_MODE = 'shadow';
    const records: ShadowRecord[] = [];
    const mw = consequenceGate({ sink: (r) => { records.push(r); } }); // default noDerive
    const { req, res } = mockReqRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(records[0]!.action).toBeNull();
    expect(records[0]!.classification).toBeNull();
    expect(records[0]!.wouldRoute).toBe('no-action');
    delete process.env.CONSEQUENCE_GATE_MODE;
  });

  it('a throwing sink never breaks the request', () => {
    process.env.CONSEQUENCE_GATE_MODE = 'shadow';
    const mw = consequenceGate({
      sink: () => { throw new Error('sink boom'); },
      deriveAction: () => ({ kind: 'read' }),
    });
    const { req, res } = mockReqRes();
    let nextCalled = false;
    expect(() => mw(req, res, () => { nextCalled = true; })).not.toThrow();
    expect(nextCalled).toBe(true);
    delete process.env.CONSEQUENCE_GATE_MODE;
  });
});

describe('wouldRouteFor + shadowClassify helpers', () => {
  it('maps tiers to spec §3 routes', () => {
    expect(wouldRouteFor(null)).toBe('no-action');
    expect(wouldRouteFor(classifyAction({ kind: 'read' }))).toBe('act');
    expect(wouldRouteFor(classifyAction({ kind: 'git', git: { operation: 'merge', targetRef: 'feat/x' } }))).toBe('adversarial-gate');
    expect(wouldRouteFor(classifyAction({ kind: 'secret' }))).toBe('HITL');
  });

  it('shadowClassify produces a record offline (no Express)', () => {
    const rec = shadowClassify({ kind: 'db', sql: 'TRUNCATE t' }, { route: '/x' });
    expect(rec.classification!.tier).toBe('T2');
    expect(rec.mode).toBe('shadow');
  });
});

describe('DEFAULT_CONFIG sanity', () => {
  it('names the prod project id from spec §3', () => {
    expect(DEFAULT_CONFIG.prodProjectIds).toContain('qnnpjhlxljtqyigedwkb');
  });
  it('evaluateRules is pure (no throw on minimal input)', () => {
    expect(() => evaluateRules({ kind: 'read' })).not.toThrow();
  });
});
