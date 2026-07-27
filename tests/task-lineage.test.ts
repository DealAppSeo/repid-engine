import {
  lineageMode,
  lineageMaxDepth,
  parseParentDepth,
  deriveLineage,
  rootLineage,
  checkDepthBudget,
  guardedLineage,
  formatLineageLog,
  MALFORMED_DEPTH,
} from '../src/services/task-lineage';

// L2 breaker 2.2 — lineage + depth budget.
//
// The properties that actually matter here are the ASYMMETRIES, because they
// are what a careless later edit will "simplify" away:
//   - mode defaults to ENFORCE (not shadow like breaker 2.0)
//   - a malformed parent depth fails CLOSED (not open like breaker 2.0)
//   - a missing parent ID does NOT reset the depth (the laundering bypass)
//   - a null depth is root, and is NOT malformed
// Each has a test whose name says which asymmetry it pins.

describe('lineageMode', () => {
  it('DEFAULTS TO ENFORCE when unset/blank/unknown — inverse of breaker 2.0', () => {
    expect(lineageMode(undefined)).toBe('enforce');
    expect(lineageMode(null)).toBe('enforce');
    expect(lineageMode('')).toBe('enforce');
    expect(lineageMode('   ')).toBe('enforce');
    expect(lineageMode('nonsense')).toBe('enforce');
  });

  it('only the exact tokens off/shadow weaken it (case/space-insensitive)', () => {
    expect(lineageMode('off')).toBe('off');
    expect(lineageMode(' OFF ')).toBe('off');
    expect(lineageMode('shadow')).toBe('shadow');
    expect(lineageMode('Shadow')).toBe('shadow');
    expect(lineageMode('enforce')).toBe('enforce');
  });

  it('near-misses of the weakening tokens do NOT weaken it', () => {
    // A typo in an env var must not silently disable a fork-bomb guard.
    for (const near of ['of', 'offf', 'shadw', 'shadows', 'false', '0', 'no',
      'disabled', 'none', 'null', 'undefined', 'off;', 'off ', 'sh adow']) {
      expect(lineageMode(near)).toBe(near === 'off ' ? 'off' : 'enforce');
    }
  });
});

describe('lineageMaxDepth', () => {
  it('defaults to 5', () => {
    expect(lineageMaxDepth(undefined)).toBe(5);
    expect(lineageMaxDepth('')).toBe(5);
  });

  it('accepts a positive integer', () => {
    expect(lineageMaxDepth('1')).toBe(1);
    expect(lineageMaxDepth('12')).toBe(12);
  });

  it('FLOORS AT 1 — a budget of 0 would refuse every root and park the system', () => {
    expect(lineageMaxDepth('0')).toBe(5);
    expect(lineageMaxDepth('-3')).toBe(5);
  });

  it('rejects non-integers and garbage rather than coercing them', () => {
    expect(lineageMaxDepth('2.5')).toBe(5);
    expect(lineageMaxDepth('abc')).toBe(5);
    expect(lineageMaxDepth('Infinity')).toBe(5);
    expect(lineageMaxDepth('NaN')).toBe(5);
  });
});

describe('parseParentDepth', () => {
  it('treats null/undefined/empty as ROOT (0) and NOT malformed', () => {
    // This is the normal case for every root task; it must not fail closed.
    expect(parseParentDepth(null)).toEqual({ depth: 0, malformed: false });
    expect(parseParentDepth(undefined)).toEqual({ depth: 0, malformed: false });
    expect(parseParentDepth('')).toEqual({ depth: 0, malformed: false });
  });

  it('accepts non-negative integers, as number or exact string', () => {
    expect(parseParentDepth(0)).toEqual({ depth: 0, malformed: false });
    expect(parseParentDepth(4)).toEqual({ depth: 4, malformed: false });
    expect(parseParentDepth('4')).toEqual({ depth: 4, malformed: false });
    expect(parseParentDepth(' 4 ')).toEqual({ depth: 4, malformed: false });
  });

  it('FAILS CLOSED on every unusable depth — inverse of breaker 2.0', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, 'abc', '1e999',
      Number.MAX_VALUE, {}, [], [0], [3], true, false, () => 0, Symbol('x')]) {
      const r = parseParentDepth(bad as unknown);
      expect(r.malformed).toBe(true);
      expect(r.depth).toBe(MALFORMED_DEPTH);
    }
  });

  it('REGRESSION: an array does not launder to root via String() coercion', () => {
    // `String([]) === ''` and `Number('') === 0`, so before the type gate an
    // array-valued generation resolved to a clean ROOT and walked through the
    // breaker. Pinned separately from the loop above so a future edit that
    // reintroduces blind coercion fails with a name that says what broke.
    expect(parseParentDepth([]).malformed).toBe(true);
    expect(parseParentDepth([3]).malformed).toBe(true);
    expect(deriveLineage({ id: 1, generation: [] as unknown }).generation).toBe(MALFORMED_DEPTH);
    expect(guardedLineage({ id: 1, generation: [] as unknown },
      { mode: 'enforce', maxDepth: 5 }).decision.halted).toBe(true);
  });

  it('MALFORMED_DEPTH survives JSON round-tripping (it is logged, not just thrown)', () => {
    expect(JSON.parse(JSON.stringify({ d: MALFORMED_DEPTH })).d).toBe(MALFORMED_DEPTH);
    expect(Number.isFinite(MALFORMED_DEPTH)).toBe(true);
  });
});

describe('deriveLineage', () => {
  it('no parent → root {null, 0}', () => {
    expect(deriveLineage()).toEqual({ parent_task_id: null, generation: 0 });
    expect(deriveLineage(null)).toEqual({ parent_task_id: null, generation: 0 });
    expect(rootLineage()).toEqual({ parent_task_id: null, generation: 0 });
  });

  it('a parent at generation N yields a child at N+1', () => {
    expect(deriveLineage({ id: 7, generation: 0 })).toEqual({ parent_task_id: 7, generation: 1 });
    expect(deriveLineage({ id: 7, generation: 4 })).toEqual({ parent_task_id: 7, generation: 5 });
  });

  it('a parent with a NULL generation is treated as a root, so the child is 1', () => {
    expect(deriveLineage({ id: 7, generation: null })).toEqual({ parent_task_id: 7, generation: 1 });
  });

  it('AN UNKNOWN PARENT ID DOES NOT RESET THE DEPTH — the laundering bypass', () => {
    // If a missing id reset generation to 0, any spawner could drop the id and
    // walk through the breaker forever. Depth must survive an unknown parent.
    expect(deriveLineage({ generation: 4 })).toEqual({ parent_task_id: null, generation: 5 });
    expect(deriveLineage({ id: null, generation: 4 })).toEqual({ parent_task_id: null, generation: 5 });
    expect(deriveLineage({ id: 'not-a-number', generation: 4 })).toEqual({ parent_task_id: null, generation: 5 });
  });

  it('coerces a BIGINT-as-string parent id (what a JSON DB row hands us)', () => {
    expect(deriveLineage({ id: '10247', generation: 1 })).toEqual({ parent_task_id: 10247, generation: 2 });
  });

  it('rejects a non-positive parent id rather than writing 0/-1 as an edge', () => {
    expect(deriveLineage({ id: 0, generation: 1 }).parent_task_id).toBeNull();
    expect(deriveLineage({ id: -5, generation: 1 }).parent_task_id).toBeNull();
  });

  it('propagates a malformed parent depth as MALFORMED_DEPTH', () => {
    expect(deriveLineage({ id: 7, generation: -1 }).generation).toBe(MALFORMED_DEPTH);
    expect(deriveLineage({ id: 7, generation: 'abc' }).generation).toBe(MALFORMED_DEPTH);
  });
});

describe('checkDepthBudget — the off-by-one is the contract', () => {
  const E = { mode: 'enforce' as const, maxDepth: 5 };

  it('allows depth exactly AT the budget (MAX(generation) <= budget)', () => {
    const d = checkDepthBudget(5, E);
    expect(d.exceeded).toBe(false);
    expect(d.halted).toBe(false);
  });

  it('refuses depth budget+1', () => {
    const d = checkDepthBudget(6, E);
    expect(d.exceeded).toBe(true);
    expect(d.halted).toBe(true);
    expect(d.reason).toContain('depth 6 > budget 5');
  });

  it('allows every depth below the budget', () => {
    for (const n of [0, 1, 2, 3, 4]) {
      expect(checkDepthBudget(n, E).exceeded).toBe(false);
    }
  });

  it('shadow mode reports exceeded but never halts', () => {
    const d = checkDepthBudget(99, { mode: 'shadow', maxDepth: 5 });
    expect(d.exceeded).toBe(true);
    expect(d.halted).toBe(false);
  });

  it('off mode neither exceeds nor halts, and says so', () => {
    const d = checkDepthBudget(99, { mode: 'off', maxDepth: 5 });
    expect(d.exceeded).toBe(false);
    expect(d.halted).toBe(false);
    expect(d.reason).toBe('mode=off');
  });

  it('OFF MODE ALSO SUPPRESSES THE FAIL-CLOSED PATH (one lever, not two)', () => {
    // An operator who sets mode=off has explicitly disabled the breaker; a
    // malformed depth must not keep refusing behind their back.
    const d = checkDepthBudget(MALFORMED_DEPTH, { mode: 'off', maxDepth: 5 });
    expect(d.halted).toBe(false);
  });

  it('a malformed depth is refused in enforce mode with a distinct reason', () => {
    const d = checkDepthBudget(MALFORMED_DEPTH, E);
    expect(d.malformed).toBe(true);
    expect(d.halted).toBe(true);
    expect(d.reason).toContain('unreadable');
    // and it must NOT masquerade as a real depth in the reason string
    expect(d.reason).not.toContain(String(MALFORMED_DEPTH));
  });

  it('infers malformed from the sentinel even when the caller does not pass the flag', () => {
    expect(checkDepthBudget(MALFORMED_DEPTH, E).malformed).toBe(true);
  });

  it('an explicit malformed=true refuses even at a small depth', () => {
    const d = checkDepthBudget(1, { ...E, malformed: true });
    expect(d.halted).toBe(true);
  });
});

describe('guardedLineage — the chokepoint call', () => {
  it('allows a shallow spawn and hands back the fields to insert', () => {
    const g = guardedLineage({ id: 9, generation: 0 }, { mode: 'enforce', maxDepth: 5 });
    expect(g.decision.halted).toBe(false);
    expect(g.fields).toEqual({ parent_task_id: 9, generation: 1 });
  });

  it('refuses a spawn that would exceed the budget', () => {
    const g = guardedLineage({ id: 9, generation: 5 }, { mode: 'enforce', maxDepth: 5 });
    expect(g.fields.generation).toBe(6);
    expect(g.decision.halted).toBe(true);
  });

  it('a full chain from root walks 0..budget then refuses — the fork-bomb walk', () => {
    const opts = { mode: 'enforce' as const, maxDepth: 5 };
    let parent: { id: number; generation: number } | null = null;
    const accepted: number[] = [];
    for (let i = 0; i < 12; i++) {
      const g = guardedLineage(parent, opts);
      if (g.decision.halted) break;
      accepted.push(g.fields.generation);
      parent = { id: 100 + i, generation: g.fields.generation };
    }
    // root 0 plus 5 descendants = 6 accepted, deepest stored generation 5.
    expect(accepted).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Math.max(...accepted)).toBe(5);
  });

  it('a malformed parent stops the walk immediately, at any depth', () => {
    const g = guardedLineage({ id: 1, generation: 'garbage' }, { mode: 'enforce', maxDepth: 5 });
    expect(g.decision.halted).toBe(true);
    expect(g.decision.malformed).toBe(true);
  });

  it('in shadow the same chain never stops (measure-only)', () => {
    const opts = { mode: 'shadow' as const, maxDepth: 5 };
    let parent: { id: number; generation: number } | null = null;
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const g = guardedLineage(parent, opts);
      if (g.decision.halted) break;
      n++;
      parent = { id: 100 + i, generation: g.fields.generation };
    }
    expect(n).toBe(20);
  });
});

describe('formatLineageLog — the operator has to be able to tell these apart', () => {
  it('says REFUSED only when it actually refused', () => {
    const halted = checkDepthBudget(9, { mode: 'enforce', maxDepth: 5 });
    expect(formatLineageLog('[X]', halted)).toContain('REFUSED');
  });

  it('SHADOW SAYS "WOULD refuse" AND NEVER "REFUSED"', () => {
    // Beat 34 shipped a banner that announced a consequence it was not having.
    // This pins the same class of defect for this breaker.
    const shadow = checkDepthBudget(9, { mode: 'shadow', maxDepth: 5 });
    const line = formatLineageLog('[X]', shadow);
    expect(line).toContain('WOULD refuse');
    expect(line).not.toMatch(/\bREFUSED\b/);
  });

  it('an allowed spawn says allowed', () => {
    const ok = checkDepthBudget(1, { mode: 'enforce', maxDepth: 5 });
    expect(formatLineageLog('[X]', ok)).toContain('allowed');
  });

  it('prints "malformed" rather than the sentinel integer', () => {
    const bad = checkDepthBudget(MALFORMED_DEPTH, { mode: 'enforce', maxDepth: 5 });
    const line = formatLineageLog('[X]', bad);
    expect(line).toContain('malformed');
    expect(line).not.toContain(String(MALFORMED_DEPTH));
  });

  it('always carries the breaker tag so a log grep finds every one', () => {
    expect(formatLineageLog('[X]', checkDepthBudget(0, { mode: 'enforce', maxDepth: 5 })))
      .toContain('(breaker 2.2)');
  });
});

describe('env-driven defaults (the deployed behaviour, not just the pure functions)', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('with NOTHING set, a 6-deep spawn is REFUSED — the guard is on out of the box', () => {
    delete process.env.LINEAGE_DEPTH_MODE;
    delete process.env.LINEAGE_MAX_DEPTH;
    expect(guardedLineage({ id: 1, generation: 5 }).decision.halted).toBe(true);
  });

  it('with NOTHING set, a 1-deep spawn is allowed — the default is inert on real traffic', () => {
    delete process.env.LINEAGE_DEPTH_MODE;
    delete process.env.LINEAGE_MAX_DEPTH;
    // Deepest generation ever observed in trinity_tasks is 1 [V sql:2026-07-27]:
    // the shipped default cannot refuse anything the system does today.
    expect(guardedLineage({ id: 1, generation: 0 }).decision.halted).toBe(false);
    expect(guardedLineage({ id: 1, generation: 1 }).decision.halted).toBe(false);
  });

  it('LINEAGE_DEPTH_MODE=off disables refusal entirely', () => {
    process.env.LINEAGE_DEPTH_MODE = 'off';
    expect(guardedLineage({ id: 1, generation: 99 }).decision.halted).toBe(false);
  });

  it('LINEAGE_MAX_DEPTH raises the budget', () => {
    process.env.LINEAGE_MAX_DEPTH = '9';
    expect(guardedLineage({ id: 1, generation: 5 }).decision.halted).toBe(false);
    expect(guardedLineage({ id: 1, generation: 9 }).decision.halted).toBe(true);
  });
});
