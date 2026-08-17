/**
 * zkRepID boundary — the tests that make the canonical name real rather than declared.
 *
 * `docs/RSI-ADOPTION-PLAN.md` §0 recorded that `zkRepID` named no code anywhere in the four
 * repos, and that adopting a term which names nothing is the failure LESSONS §5 describes. These
 * tests are what stop that recurring: after them, the name resolves to an importable surface, the
 * boundary is enumerated, and both the exclusion list and the prose are checked by machine.
 *
 * The two that matter most are the ones time can break:
 *
 *   - EVERY module under src/zkp must be classified as zkRepID or explicitly not. Add a new file
 *     there and this suite goes red until someone decides which side it falls on. That is the
 *     difference between a boundary and a snapshot of one.
 *   - The doc must enumerate the same modules as the code. A definition that drifts from what it
 *     defines is how `HAL_CANONICAL_v1.md` came to call a live module "dead code" (see the
 *     corrections in this PR's sibling branch).
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  ZKREPID_MODULES,
  ZKREPID_PURE_MODULES,
  ZKREPID_IO_EDGE_MODULES,
  NOT_ZKREPID,
} from '../src/zkrepid/boundary';

const SRC = path.join(__dirname, '../src');
const DOC = path.join(__dirname, '../docs/ZKREPID.md');

const exists = (rel: string) => fs.existsSync(path.join(SRC, `${rel}.ts`));

describe('the boundary is well-formed', () => {
  it('names at least the six RepID-specific modules', () => {
    expect(ZKREPID_MODULES.length).toBeGreaterThanOrEqual(6);
  });

  it('every zkRepID module exists on disk', () => {
    for (const m of ZKREPID_MODULES) {
      expect({ path: m.path, exists: exists(m.path) }).toEqual({ path: m.path, exists: true });
    }
  });

  it('every explicitly-excluded module exists on disk, so the exclusion list cannot rot', () => {
    for (const m of NOT_ZKREPID) {
      expect({ path: m.path, exists: exists(m.path) }).toEqual({ path: m.path, exists: true });
    }
  });

  it('every excluded module says WHY it is excluded', () => {
    for (const m of NOT_ZKREPID) {
      expect(m.why.trim().length).toBeGreaterThan(10);
    }
  });

  it('the two lists are disjoint', () => {
    const included = new Set(ZKREPID_MODULES.map((m) => m.path));
    const overlap = NOT_ZKREPID.filter((m) => included.has(m.path)).map((m) => m.path);
    expect(overlap).toEqual([]);
  });

  it('splits into a pure surface and a named I/O edge', () => {
    expect(ZKREPID_PURE_MODULES.length).toBe(5);
    expect(ZKREPID_IO_EDGE_MODULES.map((m) => m.path)).toEqual(['zkp/repid-delta-bridge']);
  });
});

describe('EVERY module under src/zkp is classified — a check time can break', () => {
  it('leaves nothing unclassified', () => {
    const classified = new Set([
      ...ZKREPID_MODULES.map((m) => m.path),
      ...NOT_ZKREPID.map((m) => m.path),
    ]);

    const onDisk = fs
      .readdirSync(path.join(SRC, 'zkp'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map((f) => `zkp/${f.replace(/\.ts$/, '')}`);

    const unclassified = onDisk.filter((p) => !classified.has(p));
    // A new file under src/zkp must be declared zkRepID or explicitly not. If this is red, that
    // decision has not been made yet — make it in src/zkrepid/boundary.ts rather than deleting
    // this assertion.
    expect(unclassified).toEqual([]);
  });
});

describe('the barrel', () => {
  it('re-exports exactly the pure surface, namespaced', () => {
    // Required at call time so the env test below can control module state independently.
    const barrel = require('../src/zkrepid') as Record<string, unknown>;
    for (const ns of ['statement', 'anchor', 'erc8004', 'holder', 'nullifier']) {
      expect(typeof barrel[ns]).toBe('object');
    }
  });

  it('does NOT re-export the I/O edge, which would make it throw for every consumer', () => {
    const barrel = require('../src/zkrepid') as Record<string, unknown>;
    expect(barrel['bridge']).toBeUndefined();
    expect(barrel['recordDeltaStatement']).toBeUndefined();
  });

  it('keeps the two colliding feltsFromString helpers distinguishable', () => {
    const barrel = require('../src/zkrepid') as {
      statement: Record<string, unknown>;
      nullifier: Record<string, unknown>;
    };
    // Both modules export this name. A flat `export *` would drop one of them silently, and this
    // is a domain-separation helper — the wrong one produces a digest under the wrong intent.
    expect(typeof barrel.statement.feltsFromString).toBe('function');
    expect(typeof barrel.nullifier.feltsFromString).toBe('function');
    expect(barrel.statement.feltsFromString).not.toBe(barrel.nullifier.feltsFromString);
  });

  it('exposes the canonical RepID delta domain, so the name reaches a real constant', () => {
    const barrel = require('../src/zkrepid') as { statement: { REPID_DELTA_DOMAIN: string } };
    expect(barrel.statement.REPID_DELTA_DOMAIN).toBe('hyperdag/repid/delta/v1');
  });
});

describe('the barrel imports with NO environment set', () => {
  it('needs no Supabase credentials', () => {
    const saved = {
      url: process.env.SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_KEY,
      secret: process.env.SUPABASE_SECRET_KEY,
      role: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    jest.resetModules();
    try {
      // The property under test: a consumer wanting a domain constant must not be forced to hold
      // database credentials. If this throws, something impure was added to the barrel.
      expect(() => require('../src/zkrepid')).not.toThrow();
    } finally {
      if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_KEY = saved.key;
      if (saved.secret !== undefined) process.env.SUPABASE_SECRET_KEY = saved.secret;
      if (saved.role !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.role;
      jest.resetModules();
    }
  });
});

describe('the doc and the code agree', () => {
  const doc = fs.readFileSync(DOC, 'utf8');

  it('the doc names every zkRepID module', () => {
    for (const m of ZKREPID_MODULES) {
      expect({ module: m.path, inDoc: doc.includes(`src/${m.path}.ts`) }).toEqual({
        module: m.path,
        inDoc: true,
      });
    }
  });

  it('the doc names every excluded module', () => {
    for (const m of NOT_ZKREPID) {
      expect({ module: m.path, inDoc: doc.includes(`src/${m.path}.ts`) }).toEqual({
        module: m.path,
        inDoc: true,
      });
    }
  });

  it('the doc records that the database columns cannot be renamed from this repo', () => {
    // The single most likely future mistake is someone "finishing" the rename by renaming these.
    expect(doc).toMatch(/zkp_proof_cid/);
    expect(doc).toMatch(/externally-managed|managed externally/i);
  });
});
