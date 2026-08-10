/**
 * The write-lease fence.
 *
 * Parallel worktree agents have already cross-contaminated `config.ts` and
 * `x402-real-settler.ts` in this repo. These tests pin the properties that make it
 * impossible rather than discouraged — and, critically, the properties that stop the
 * fence itself becoming the outage: leases expire, adoption is graduated, and the two
 * implementations (the TS module and the dependency-free hook) agree.
 */

import {
  DEFAULT_TTL_MS,
  EMPTY_REGISTRY,
  HEARTBEAT_TTL_MS,
  LANE_ENV,
  MAX_LEASE_AGE_MS,
  acquireLease,
  activeLeases,
  renewLease,
  currentLane,
  evaluateWrite,
  globToRegExp,
  isExpired,
  literalPrefix,
  matchesAny,
  normalisePath,
  patternsMayOverlap,
  readRegistry,
  withLease,
  withoutLane,
  type LeaseRegistry,
  type WriteLease,
} from '../src/orchestration/write-lease';

// The hook duplicates the core deliberately (no deps, no build). Equivalence is tested.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const hookModulePath = require.resolve('../scripts/hooks/lane-write-guard.js');

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const lease = (over: Partial<WriteLease> = {}): WriteLease => ({
  lane: 'GA',
  paths: ['src/hal/**'],
  branch: 'feat/ga-hal',
  purpose: 'HAL precision cycle 4',
  acquiredAt: iso(NOW - 60_000),
  expiresAt: iso(NOW + 60 * 60_000),
  ...over,
});

const reg = (...leases: WriteLease[]): LeaseRegistry => ({ version: 1, leases });

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

describe('glob matching', () => {
  it('** crosses directories, * does not', () => {
    expect(globToRegExp('src/**').test('src/hal/lib/evaluate.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/index.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/hal/evaluate.ts')).toBe(false);
  });

  it('**/ matches zero segments too, so src/**/x.ts covers src/x.ts', () => {
    expect(globToRegExp('src/**/x.ts').test('src/x.ts')).toBe(true);
    expect(globToRegExp('src/**/x.ts').test('src/a/b/x.ts')).toBe(true);
  });

  it('anchors at both ends — a pattern is not a substring search', () => {
    expect(globToRegExp('src/hal/**').test('other/src/hal/a.ts')).toBe(false);
    expect(globToRegExp('src/a.ts').test('src/a.ts.bak')).toBe(false);
  });

  it('treats regex metacharacters in a path as literals', () => {
    expect(globToRegExp('src/a+b(c).ts').test('src/a+b(c).ts')).toBe(true);
    expect(globToRegExp('src/a.ts').test('src/aXts')).toBe(false);
  });

  it('normalises Windows separators and absolute paths', () => {
    expect(normalisePath('C:\\repo\\src\\hal\\a.ts', 'C:/repo')).toBe('src/hal/a.ts');
    expect(normalisePath('./src/a.ts')).toBe('src/a.ts');
  });

  it('normalises case-insensitively on the root, since Windows varies drive case', () => {
    expect(normalisePath('c:/Repo/src/a.ts', 'C:/repo')).toBe('src/a.ts');
  });
});

// ---------------------------------------------------------------------------
// Overlap: over-approximate, never miss
// ---------------------------------------------------------------------------

describe('overlap detection over-approximates on purpose', () => {
  it('separate subtrees do NOT conflict — the whole point of parallel lanes', () => {
    expect(patternsMayOverlap('src/hal/**', 'src/scoring/**')).toBe(false);
    expect(patternsMayOverlap('src/zkp/**', 'src/billing/**')).toBe(false);
  });

  it('THE CASE THAT BURNED US: the same file claimed twice conflicts', () => {
    expect(patternsMayOverlap('src/config.ts', 'src/config.ts')).toBe(true);
    expect(patternsMayOverlap('src/services/x402-real-settler.ts', 'src/services/**')).toBe(true);
  });

  it('a nested subtree conflicts with its parent', () => {
    expect(patternsMayOverlap('src/**', 'src/hal/**')).toBe(true);
  });

  it('over-reports rather than missing — two disjoint globs under one dir conflict', () => {
    // src/*/a.ts and src/*/b.ts can never match the same file, yet both share the
    // literal prefix src/. Reporting a conflict costs a conversation; missing one
    // costs a night's work.
    expect(patternsMayOverlap('src/*/a.ts', 'src/*/b.ts')).toBe(true);
  });

  it('a bare wildcard has an empty prefix and therefore conflicts with everything', () => {
    expect(literalPrefix('**/*.ts')).toBe('');
    expect(patternsMayOverlap('**/*.ts', 'src/hal/**')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Expiry — the liveness property
// ---------------------------------------------------------------------------

describe('leases expire, so a crashed agent cannot lock the repo', () => {
  it('an elapsed lease is inactive', () => {
    expect(isExpired(lease({ expiresAt: iso(NOW - 1) }), NOW)).toBe(true);
    expect(isExpired(lease({ expiresAt: iso(NOW + 1) }), NOW)).toBe(false);
  });

  it('exactly-now counts as expired — never hold a path on a boundary', () => {
    expect(isExpired(lease({ expiresAt: iso(NOW) }), NOW)).toBe(true);
  });

  it('an UNPARSEABLE expiry is expired — a lease that cannot say when it ends holds nothing', () => {
    expect(isExpired(lease({ expiresAt: 'whenever' }), NOW)).toBe(true);
    expect(isExpired(lease({ expiresAt: '' }), NOW)).toBe(true);
  });

  it('expired leases are filtered, not mutated — cleanup would be a race', () => {
    const r = reg(lease({ lane: 'GA', expiresAt: iso(NOW - 1) }), lease({ lane: 'XC' }));
    expect(activeLeases(r, NOW).map((l) => l.lane)).toEqual(['XC']);
    expect(r.leases).toHaveLength(2); // untouched
  });

  it('THE LIVENESS CASE: a crashed lane‘s path is writable again after the TTL', () => {
    const crashed = reg(lease({ lane: 'GA', expiresAt: iso(NOW - 1) }));
    const d = evaluateWrite({ registry: crashed, lane: 'XC', file: 'src/hal/a.ts', now: NOW });
    expect(d.verdict).toBe('allow');
  });

  it('the default TTL is long enough for a sprint and short enough to self-heal', () => {
    expect(DEFAULT_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// The graduated decision
// ---------------------------------------------------------------------------

describe('lane definitions are disjoint BY TEST, not by good intentions', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LANE_DEFINITIONS, allLanePaths, laneById } = require('../src/orchestration/lanes');

  it('THE INVARIANT: no two lanes hold overlapping globs', () => {
    const all = allLanePaths();
    const collisions: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (a.lane !== b.lane && patternsMayOverlap(a.pattern, b.pattern)) {
          collisions.push(`${a.lane}:${a.pattern} <-> ${b.lane}:${b.pattern}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('every lane claims at least one path — an empty lane cannot take a lease', () => {
    for (const l of LANE_DEFINITIONS) expect(l.paths.length).toBeGreaterThan(0);
  });

  it('lane ids are unique', () => {
    const ids = LANE_DEFINITIONS.map((l: { id: string }) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('an unknown lane resolves to undefined, not a throw — unknown means advisory', () => {
    expect(laneById('nope')).toBeUndefined();
  });

  it('the four lanes can all hold their leases simultaneously', () => {
    let registry: LeaseRegistry = EMPTY_REGISTRY;
    for (const l of LANE_DEFINITIONS) {
      const r = acquireLease(registry, { lane: l.id, paths: l.paths, branch: `feat/${l.id}`, purpose: l.owns }, NOW);
      expect(r.ok).toBe(true);
      registry = withLease(registry, r.lease!, NOW);
    }
    expect(registry.leases).toHaveLength(LANE_DEFINITIONS.length);
  });

  it('reports/ is deliberately unleased, so an eval can always write its own output', () => {
    const patterns = allLanePaths().map((p: { pattern: string }) => p.pattern);
    expect(patterns.some((p: string) => p.startsWith('reports/'))).toBe(false);
  });
});

describe('heartbeat — liveness without punishing long work', () => {
  it('renewal pushes the expiry out and stamps proof of life', () => {
    const r = renewLease(reg(lease({ expiresAt: iso(NOW + 60_000) })), 'GA', NOW);
    expect(r.ok).toBe(true);
    const l = r.registry.leases.find((x) => x.lane === 'GA')!;
    expect(Date.parse(l.expiresAt)).toBe(NOW + HEARTBEAT_TTL_MS);
    expect(l.heartbeatAt).toBe(iso(NOW));
  });

  it('THE POINT: a silent lane frees its paths in one window, not one TTL', () => {
    const held = reg(lease({ expiresAt: iso(NOW + HEARTBEAT_TTL_MS) }));
    // Lane dies. One window later nothing renewed it.
    expect(activeLeases(held, NOW + HEARTBEAT_TTL_MS + 1)).toHaveLength(0);
    expect(HEARTBEAT_TTL_MS).toBeLessThan(DEFAULT_TTL_MS);
  });

  it('renewal CANNOT widen paths — a heartbeat is not a second acquire', () => {
    const before = lease({ paths: ['src/hal/**'] });
    const after = renewLease(reg(before), 'GA', NOW).registry.leases[0]!;
    expect(after.paths).toEqual(['src/hal/**']);
  });

  it('refuses to resurrect an EXPIRED lease — those paths may be someone else‘s now', () => {
    const dead = reg(lease({ expiresAt: iso(NOW - 1) }));
    const r = renewLease(dead, 'GA', NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/re-acquire/);
    expect(r.registry.leases).toHaveLength(0);
  });

  it('refuses a lane that holds nothing', () => {
    expect(renewLease(EMPTY_REGISTRY, 'GA', NOW).ok).toBe(false);
  });

  it('NO IMMORTAL LEASE: heartbeats cannot extend past the hard ceiling', () => {
    const old = lease({
      acquiredAt: iso(NOW - MAX_LEASE_AGE_MS + 60_000), // 1 min of ceiling left
      expiresAt: iso(NOW + 60_000),
    });
    const l = renewLease(reg(old), 'GA', NOW).registry.leases.find((x) => x.lane === 'GA')!;
    // Wanted NOW + 15m; ceiling allows only NOW + 1m.
    expect(Date.parse(l.expiresAt)).toBe(NOW + 60_000);
  });

  it('at the ceiling it reports NOT ok, so a stuck loop surfaces to a human', () => {
    const r = renewLease(reg(lease({ acquiredAt: iso(NOW - MAX_LEASE_AGE_MS) })), 'GA', NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ceiling/);
  });

  it('a malformed acquiredAt does not produce a NaN expiry that silently kills a live lane', () => {
    const l = renewLease(reg(lease({ acquiredAt: 'not-a-date' })), 'GA', NOW)
      .registry.leases.find((x) => x.lane === 'GA')!;
    expect(Number.isFinite(Date.parse(l.expiresAt))).toBe(true);
    expect(isExpired(l, NOW)).toBe(false);
  });

  it('renewing one lane leaves other lanes untouched', () => {
    const other = lease({ lane: 'CC', paths: ['src/zkp/**'] });
    const out = renewLease(reg(lease(), other), 'GA', NOW).registry;
    expect(out.leases.find((l) => l.lane === 'CC')!.expiresAt).toBe(other.expiresAt);
  });

  it('legacy leases with no heartbeatAt still work — expiresAt stays authoritative', () => {
    const legacy = lease();
    expect(legacy.heartbeatAt).toBeUndefined();
    expect(isExpired(legacy, NOW)).toBe(false);
  });
});

describe('graduated adoption — turning this on cannot brick the repo', () => {
  it('no leases at all → allow everything', () => {
    expect(evaluateWrite({ registry: EMPTY_REGISTRY, lane: 'GA', file: 'src/a.ts', now: NOW }).verdict).toBe(
      'allow',
    );
  });

  it('an unleased path is allowed even while other leases are active', () => {
    const d = evaluateWrite({ registry: reg(lease()), lane: 'XC', file: 'src/billing/pricing.ts', now: NOW });
    expect(d.verdict).toBe('allow');
  });

  it('THE FENCE: another lane‘s leased file is DENIED', () => {
    const d = evaluateWrite({ registry: reg(lease()), lane: 'XC', file: 'src/hal/fact-check.ts', now: NOW });
    expect(d.verdict).toBe('deny');
    expect(d.heldBy?.lane).toBe('GA');
    // The denial must explain itself — the agent has to be able to pick other work.
    expect(d.message).toContain('GA');
    expect(d.message).toContain('HAL precision cycle 4');
    expect(d.message).toContain('feat/ga-hal');
  });

  it('the lease holder may write its own path', () => {
    const d = evaluateWrite({ registry: reg(lease()), lane: 'GA', file: 'src/hal/fact-check.ts', now: NOW });
    expect(d.verdict).toBe('allow');
  });

  it('A HUMAN IS NEVER BLOCKED: no lane set → advise, not deny', () => {
    // Sean at a terminal must not be locked out of his own repo by robot bookkeeping.
    const d = evaluateWrite({ registry: reg(lease()), lane: null, file: 'src/hal/fact-check.ts', now: NOW });
    expect(d.verdict).toBe('advise');
    expect(d.message).toContain(LANE_ENV);
  });

  it('holding a lease does not CONFINE the holder to it', () => {
    // A lease claims territory; it does not fence the holder in. Confinement would mean
    // every incidental edit needs a new lease, and a fence that fires constantly gets
    // switched off.
    const d = evaluateWrite({ registry: reg(lease()), lane: 'GA', file: 'README.md', now: NOW });
    expect(d.verdict).toBe('allow');
  });

  it('the FIRST matching lease decides, deterministically', () => {
    const r = reg(lease({ lane: 'GA', paths: ['src/**'] }), lease({ lane: 'XC', paths: ['src/hal/**'] }));
    expect(evaluateWrite({ registry: r, lane: 'CC', file: 'src/hal/a.ts', now: NOW }).heldBy?.lane).toBe('GA');
  });
});

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

describe('acquiring a lease', () => {
  const req = { lane: 'XC', paths: ['src/scoring/**'], branch: 'feat/xc', purpose: 'red-team' };

  it('succeeds against a non-overlapping lease', () => {
    const r = acquireLease(reg(lease()), req, NOW);
    expect(r.ok).toBe(true);
    expect(r.lease?.expiresAt).toBe(iso(NOW + DEFAULT_TTL_MS));
  });

  it('REFUSES on overlap, and names who holds what', () => {
    const r = acquireLease(reg(lease()), { ...req, paths: ['src/hal/lib/**'] }, NOW);
    expect(r.ok).toBe(false);
    expect(r.conflicts.map((c) => c.lane)).toEqual(['GA']);
    expect(r.reason).toContain('HAL precision cycle 4');
  });

  it('ignores an EXPIRED lease when checking overlap', () => {
    const r = acquireLease(reg(lease({ expiresAt: iso(NOW - 1) })), { ...req, paths: ['src/hal/**'] }, NOW);
    expect(r.ok).toBe(true);
  });

  it('a lane re-acquiring its OWN paths always succeeds — that is renewal', () => {
    const r = acquireLease(reg(lease()), { lane: 'GA', paths: ['src/hal/**'], branch: 'b', purpose: 'p' }, NOW);
    expect(r.ok).toBe(true);
  });

  it('refuses an empty lease — claiming nothing is a bug, not a no-op', () => {
    expect(acquireLease(EMPTY_REGISTRY, { ...req, paths: [] }, NOW).ok).toBe(false);
  });

  it('honours a custom TTL', () => {
    const r = acquireLease(EMPTY_REGISTRY, { ...req, ttlMs: 60_000 }, NOW);
    expect(r.lease?.expiresAt).toBe(iso(NOW + 60_000));
  });

  it('withLease replaces the lane‘s own lease and drops expired ones', () => {
    const r = reg(lease({ lane: 'GA', paths: ['src/old/**'] }), lease({ lane: 'CC', expiresAt: iso(NOW - 1) }));
    const next = withLease(r, lease({ lane: 'GA', paths: ['src/new/**'] }), NOW);
    expect(next.leases).toHaveLength(1);
    expect(next.leases[0]!.paths).toEqual(['src/new/**']);
  });

  it('withoutLane releases only that lane', () => {
    const next = withoutLane(reg(lease({ lane: 'GA' }), lease({ lane: 'XC' })), 'GA', NOW);
    expect(next.leases.map((l) => l.lane)).toEqual(['XC']);
  });
});

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------

describe('fails open, deliberately', () => {
  it('a missing or unreadable registry is EMPTY, not an error', () => {
    expect(readRegistry(null)).toEqual(EMPTY_REGISTRY);
    expect(readRegistry('C:/definitely/not/a/real/path/x.json')).toEqual(EMPTY_REGISTRY);
  });

  it('drops malformed lease entries rather than rejecting the whole file', () => {
    // One bad row must not disable the fence for every other lane.
    const path = require('node:path').join(
      require('node:os').tmpdir(),
      `lease-test-${process.pid}.json`,
    );
    require('node:fs').writeFileSync(
      path,
      JSON.stringify({ version: 1, leases: [{ nonsense: true }, lease({ lane: 'GA' })] }),
    );
    try {
      const r = readRegistry(path);
      expect(r.leases).toHaveLength(1);
      expect(r.leases[0]!.lane).toBe('GA');
    } finally {
      require('node:fs').unlinkSync(path);
    }
  });

  it('currentLane is null when unset, and trims whitespace', () => {
    const prev = process.env[LANE_ENV];
    try {
      delete process.env[LANE_ENV];
      expect(currentLane()).toBeNull();
      process.env[LANE_ENV] = '   ';
      expect(currentLane()).toBeNull();
      process.env[LANE_ENV] = ' GA ';
      expect(currentLane()).toBe('GA');
    } finally {
      if (prev === undefined) delete process.env[LANE_ENV];
      else process.env[LANE_ENV] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// The two implementations must agree
// ---------------------------------------------------------------------------

describe('the hook and the module agree (duplication is only safe if pinned)', () => {
  /** Drive the real hook the way the harness does: JSON on stdin, exit code out. */
  function runHook(args: {
    lane: string | null;
    file: string;
    leases: WriteLease[];
    cwd?: string;
    /** Overrides the `cwd` field written into the payload, to test bad values. */
    payloadCwd?: string;
    /** The clock the fixture's timestamps are expressed against. Defaults to NOW. */
    refNow?: number;
  }): { code: number; stderr: string } {
    const fs = require('node:fs') as typeof import('node:fs');
    const cp = require('node:child_process') as typeof import('node:child_process');
    const cwd = args.cwd ?? process.cwd();
    const commonDir = cp
      .execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
      })
      .trim();
    const leasePath = require('node:path').join(commonDir, 'hyperdag-lane-leases.json');
    const had = fs.existsSync(leasePath);
    const backup = had ? fs.readFileSync(leasePath, 'utf8') : null;
    try {
      // ⚠ THE SUBPROCESS HAS ITS OWN CLOCK. The pure-module tests use a FIXED `NOW`
      // for determinism, but the hook reads `Date.now()`. A lease written with a
      // fixed expiry is active only while the wall clock happens to be before it —
      // which is exactly the bug this shifted-timestamp mapping fixes: these tests
      // passed when written at 12:0x UTC and began failing at 13:00 UTC when the
      // fixture's one-hour lease elapsed in real time. A test that depends on the
      // time of day is worse than no test, because it lands green and rots.
      //
      // Preserve each lease's offset RELATIVE to the fixed NOW, re-based onto real
      // time. An intentionally-expired fixture (offset -1ms) stays expired; an
      // active one stays active, at any hour.
      const ref = args.refNow ?? NOW;
      const rebased = args.leases.map((l) => ({
        ...l,
        expiresAt: new Date(Date.now() + (Date.parse(l.expiresAt) - ref)).toISOString(),
        acquiredAt: new Date(Date.now() + (Date.parse(l.acquiredAt) - ref)).toISOString(),
      }));
      fs.writeFileSync(leasePath, JSON.stringify({ version: 1, leases: rebased }));
      const env = { ...process.env };
      if (args.lane) env.HYPERDAG_LANE = args.lane;
      else delete env.HYPERDAG_LANE;
      const r = cp.spawnSync(process.execPath, [hookModulePath], {
        input: JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: args.file },
          cwd: args.payloadCwd !== undefined ? args.payloadCwd : cwd,
        }),
        env,
        encoding: 'utf8',
      });
      return { code: r.status ?? 0, stderr: r.stderr ?? '' };
    } finally {
      if (backup !== null) fs.writeFileSync(leasePath, backup);
      else if (fs.existsSync(leasePath)) fs.unlinkSync(leasePath);
    }
  }

  const cases: Array<{ name: string; lane: string | null; file: string; leases: WriteLease[] }> = [
    { name: 'other lane holds it', lane: 'XC', file: 'src/hal/fact-check.ts', leases: [lease()] },
    { name: 'own lane holds it', lane: 'GA', file: 'src/hal/fact-check.ts', leases: [lease()] },
    { name: 'unleased path', lane: 'XC', file: 'src/billing/pricing.ts', leases: [lease()] },
    { name: 'no lane set', lane: null, file: 'src/hal/fact-check.ts', leases: [lease()] },
    { name: 'no leases', lane: 'XC', file: 'src/hal/fact-check.ts', leases: [] },
    {
      name: 'expired lease',
      lane: 'XC',
      file: 'src/hal/fact-check.ts',
      leases: [lease({ expiresAt: iso(NOW - 1) })],
    },
  ];

  for (const c of cases) {
    it(`agrees: ${c.name}`, () => {
      // Compare against the FIXED clock, since runHook rebases the fixture onto real
      // time by the same offset. Using Date.now() here would make both sides agree on
      // "expired" and quietly stop testing anything.
      const expected = evaluateWrite({ registry: reg(...c.leases), lane: c.lane, file: c.file, now: NOW });
      const got = runHook(c);
      // deny → exit 2 (the harness's blocking signal); everything else → exit 0.
      expect(got.code).toBe(expected.verdict === 'deny' ? 2 : 0);
      if (expected.verdict === 'deny') expect(got.stderr).toContain('BLOCKED');
      if (expected.verdict === 'advise') expect(got.stderr).toContain('lane write-lease');
      if (expected.verdict === 'allow') expect(got.stderr).toBe('');
    });
  }

  it('THE SILENT-DISABLE REGRESSION: an unusable payload cwd must still enforce', () => {
    // Caught in manual testing: a POSIX-style cwd (`/c/Users/...`) makes execFileSync
    // fail to chdir on Windows, so `git` never ran, `commonDir` was null, and the hook
    // exited 0. The fence had silently disabled itself while looking healthy — the
    // worst possible failure for a guard. It now falls back to process.cwd().
    const got = runHook({
      lane: 'XC',
      file: 'src/hal/fact-check.ts',
      leases: [lease()],
      payloadCwd: '/c/definitely/not/a/windows/path',
    });
    expect(got.code).toBe(2);
    expect(got.stderr).toContain('BLOCKED');
  });

  it('enforces on an ABSOLUTE file path, which is what the harness actually sends', () => {
    const cp = require('node:child_process') as typeof import('node:child_process');
    const root = cp
      .execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
      .trim();
    const got = runHook({ lane: 'XC', file: `${root}/src/hal/fact-check.ts`, leases: [lease()] });
    expect(got.code).toBe(2);
  });

  it('enforces on a native-separator absolute path too', () => {
    const cp = require('node:child_process') as typeof import('node:child_process');
    const root = cp
      .execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
      .trim()
      .split('/')
      .join('\\');
    const got = runHook({ lane: 'XC', file: `${root}\\src\\hal\\fact-check.ts`, leases: [lease()] });
    expect(got.code).toBe(2);
  });

  it('THE TIME BOMB: enforcement holds against any reference clock', () => {
    // The three tests above were merged GREEN and began failing 22 minutes later, when
    // the fixture's fixed one-hour lease elapsed in real time. A test that depends on
    // the time of day is worse than no test: it lands green and rots.
    //
    // runHook now re-bases the fixture onto real time, preserving each lease's offset
    // from its own reference clock. Proving that means running the SAME case against a
    // clock far in the past and one far in the future — both must block, because in
    // both the lease is active relative to its own reference.
    for (const [label, ref] of [
      ['past', Date.parse('2020-01-01T00:00:00.000Z')],
      ['future', Date.parse('2030-01-01T00:00:00.000Z')],
    ] as const) {
      const l = lease();
      const span = Date.parse(l.expiresAt) - NOW; // +1h, active
      const got = runHook({
        lane: 'XC',
        file: 'src/hal/fact-check.ts',
        refNow: ref,
        leases: [{ ...l, acquiredAt: new Date(ref - 60_000).toISOString(), expiresAt: new Date(ref + span).toISOString() }],
      });
      expect({ label, code: got.code }).toEqual({ label, code: 2 });
    }
  });

  it('an intentionally-expired fixture stays expired under re-basing', () => {
    // The other half of the rebase: a negative offset must not become active.
    const ref = Date.parse('2030-01-01T00:00:00.000Z');
    const got = runHook({
      lane: 'XC',
      file: 'src/hal/fact-check.ts',
      refNow: ref,
      leases: [{ ...lease(), acquiredAt: new Date(ref - 60_000).toISOString(), expiresAt: new Date(ref - 1).toISOString() }],
    });
    expect(got.code).toBe(0);
  });

  it('exits 0 on empty stdin — a malformed invocation must not block a write', () => {
    const cp = require('node:child_process') as typeof import('node:child_process');
    const r = cp.spawnSync(process.execPath, [hookModulePath], { input: '', encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('exits 0 on unparseable stdin', () => {
    const cp = require('node:child_process') as typeof import('node:child_process');
    const r = cp.spawnSync(process.execPath, [hookModulePath], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('exits 0 when the payload has no file path (a non-file tool)', () => {
    const cp = require('node:child_process') as typeof import('node:child_process');
    const r = cp.spawnSync(process.execPath, [hookModulePath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});
