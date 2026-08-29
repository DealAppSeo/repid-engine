/**
 * RepID preview — the no-write guarantee, and what a preview refuses to state.
 *
 * The load-bearing test here is `cannot reach the database client`, and it is
 * STRUCTURAL: it walks the import graph from `src/engine/repid-preview.ts` and
 * asserts `src/db.ts` is not reachable. A comment saying "this module does not
 * write" is worth nothing; an import walk fails when someone adds the import.
 *
 * That walk has an ANCHOR — the same function is run against
 * `src/engine/repid-update.ts`, which certainly does reach the database, and the
 * test requires it to say so. Without that case a broken walker (a regex that
 * matches nothing, a resolver returning early) would report a clean graph for
 * every input and read as a pass. Two of this project's first three red-team
 * findings were bugs in the probe rather than the subject, and both were caught
 * by exactly this: a case that was supposed to fail and didn't.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';

// computeTier lives in the scoring engine, which imports ../db → config.ts, which
// throws without these. Dummies satisfy the presence check only; nothing here
// touches a database.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import {
  previewEvent,
  previewRepId,
  previewCatalog,
  previewTier,
  PREVIEW_BASE_REPID,
} from '../src/engine/repid-preview';
import { FIXED_DELTAS, REPID_MAX, REPID_MIN } from '../src/scoring/repid-deltas';

const SRC = resolve(__dirname, '..', 'src');

/**
 * Every local module reachable from `entry`, following relative imports only.
 * Package imports are not followed — the question is whether OUR code reaches
 * OUR database client, and no npm package can import `src/db.ts`.
 */
function reachableLocalModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    // `from './x'` / `from '../x'`, covering both `import` and `import type`,
    // plus bare side-effect imports (`import './x'`) and re-exports.
    const specifiers = [...source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)];
    for (const match of specifiers) {
      const spec = match[1];
      if (!spec) continue;
      const base = resolve(dirname(file), spec);
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

describe('repid-preview — the no-write guarantee is structural', () => {
  const dbModule = join(SRC, 'db.ts');

  it('ANCHOR: the walker detects the database client when it IS reachable', () => {
    // If this fails, every "clean" result below is meaningless — the walker is
    // broken, not the subject clean.
    const reachable = reachableLocalModules(join(SRC, 'engine', 'repid-update.ts'));
    expect(reachable.has(dbModule)).toBe(true);
  });

  it('cannot reach the database client', () => {
    const reachable = reachableLocalModules(join(SRC, 'engine', 'repid-preview.ts'));
    expect([...reachable].filter((f) => f === dbModule)).toEqual([]);
  });

  it('reaches exactly one local module, so a heavy import shows up as a diff', () => {
    const reachable = reachableLocalModules(join(SRC, 'engine', 'repid-preview.ts'));
    const relative = [...reachable].map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/')).sort();
    expect(relative).toEqual(['engine/repid-preview.ts', 'scoring/repid-deltas.ts']);
  });

  it('the tariff module itself imports nothing at all', () => {
    const source = readFileSync(join(SRC, 'scoring', 'repid-deltas.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe('repid-preview — what it refuses to state', () => {
  it('does NOT preview STAKE at its tariff value, which the live path never awards', () => {
    expect(FIXED_DELTAS.STAKE).toBe(5); // the tariff says +5 …
    const preview = previewEvent('STAKE');
    expect(preview.delta).toBeNull(); // … and the preview refuses to repeat it
    expect(preview.verdict).toBe('NOT_CHECKED');
    expect(preview.reason).toMatch(/on-chain verifier/);
  });

  it('the live path still hard-codes STAKE to 0 — if this changes, revisit the classification', () => {
    // A drift guard, not a behaviour test. STAKE is NOT_CHECKED above *because*
    // the engine overrides the tariff to 0; when a real verifier lands, that
    // override goes and the preview should be reconsidered in the same change.
    const engine = readFileSync(join(SRC, 'engine', 'repid-update.ts'), 'utf8');
    expect(engine).toMatch(/eventType === 'STAKE'[\s\S]{0,2000}rawDelta = 0;/);
  });

  it('returns NOT_CHECKED, never a stand-in 0, for scorer-computed events', () => {
    for (const eventType of ['CHALLENGE_WIN', 'CHALLENGE_LOSS', 'PREDICTION_RESOLVE']) {
      const preview = previewEvent(eventType);
      expect(preview.verdict).toBe('NOT_CHECKED');
      expect(preview.delta).toBeNull();
      expect(preview.reason.length).toBeGreaterThan(20);
    }
  });

  it('returns NOT_CHECKED for every defended-deception class', () => {
    const deception = previewCatalog().filter((e) => e.eventType.startsWith('DEFENDED_DECEPTION_'));
    expect(deception).toHaveLength(8);
    for (const event of deception) {
      expect(event.verdict).toBe('NOT_CHECKED');
      expect(event.delta).toBeNull();
    }
  });

  it('returns FAILED for an event class that does not exist', () => {
    const preview = previewEvent('FREE_REPUTATION_PLEASE');
    expect(preview.verdict).toBe('FAILED');
    expect(preview.delta).toBeNull();
  });

  it('every catalog entry carries one of the three preview verdicts and never MEASURED', () => {
    for (const event of previewCatalog()) {
      expect(['APPROXIMATE', 'NOT_CHECKED', 'FAILED']).toContain(event.verdict);
      expect(event.verdict).not.toBe('MEASURED');
      // delta is non-null if and only if the verdict is APPROXIMATE
      expect(event.delta !== null).toBe(event.verdict === 'APPROXIMATE');
    }
  });
});

describe('repid-preview — the values it does state match the live tariff', () => {
  it('prices each previewable action at exactly its FIXED_DELTAS entry', () => {
    for (const event of previewCatalog()) {
      if (event.verdict !== 'APPROXIMATE') continue;
      expect(event.delta).toBe(FIXED_DELTAS[event.eventType as keyof typeof FIXED_DELTAS]);
    }
  });

  it('flags the self-reported positives as contingent on evidence', () => {
    expect(previewEvent('CODE_CONTRIBUTION').contingentOnEvidence).toBe(true);
    expect(previewEvent('REFERRAL').contingentOnEvidence).toBe(true);
    // …and does not over-claim the contingency on types the gate does not cover.
    expect(previewEvent('HANDOFF_COSIGN_VERIFIED').contingentOnEvidence).toBe(false);
    expect(previewEvent('UNSUPPORTED_CLAIM').contingentOnEvidence).toBe(false);
  });

  it('previews penalties undampened, since the redemption modifier needs history', () => {
    expect(previewEvent('UNSUPPORTED_CLAIM').delta).toBe(-8);
    expect(previewEvent('PEER_VERIFY_WRONG_CALL').delta).toBe(-5);
  });
});

describe('repid-preview — projection', () => {
  it('starts from the canonical baseline and sums only APPROXIMATE deltas', () => {
    const preview = previewRepId({ eventTypes: ['CODE_CONTRIBUTION', 'REFERRAL'] });
    expect(preview.baseRepId).toBe(PREVIEW_BASE_REPID);
    expect(preview.projectedRepId).toBe(PREVIEW_BASE_REPID + 25 + 20);
  });

  it('a NOT_CHECKED event contributes NOTHING — not a zero that looks like a result', () => {
    const withStake = previewRepId({ eventTypes: ['CODE_CONTRIBUTION', 'STAKE'] });
    const without = previewRepId({ eventTypes: ['CODE_CONTRIBUTION'] });
    expect(withStake.projectedRepId).toBe(without.projectedRepId);
    // The difference is visible in the events list, not hidden by the equality.
    expect(withStake.events.map((e) => e.verdict)).toEqual(['APPROXIMATE', 'NOT_CHECKED']);
  });

  it('clamps to the same range the live path clamps to', () => {
    const high = previewRepId({ baseRepId: REPID_MAX, eventTypes: ['CODE_CONTRIBUTION'] });
    expect(high.projectedRepId).toBe(REPID_MAX);
    const low = previewRepId({ baseRepId: REPID_MIN, eventTypes: ['UNSUPPORTED_CLAIM'] });
    expect(low.projectedRepId).toBe(REPID_MIN);
  });

  it('the live clamp still uses the same bounds — drift guard', () => {
    const engine = readFileSync(join(SRC, 'engine', 'repid-update.ts'), 'utf8');
    expect(engine).toContain(`Math.max(${REPID_MIN}, Math.min(${REPID_MAX},`);
  });

  it('labels itself APPROXIMATE and unpersisted in the shape, not just in prose', () => {
    const preview = previewRepId({ eventTypes: ['REFERRAL'] });
    expect(preview.measurement).toBe('APPROXIMATE');
    expect(preview.persisted).toBe(false);
    expect(preview.omits.length).toBeGreaterThanOrEqual(4);
    expect(preview.omits.join(' ')).toMatch(/decay/);
    expect(preview.omits.join(' ')).toMatch(/redemption/);
    expect(preview.omits.join(' ')).toMatch(/ecosystem-need/);
  });

  it('warns that the previewed tier is not the tier the database will derive', () => {
    const preview = previewRepId({ baseRepId: 9000, eventTypes: [] });
    expect(preview.projectedTier).toBe('VETERAN');
    expect(preview.tierIsCounterpartyGateApproximation).toBe(true);
    expect(preview.tierCaveat).toMatch(/counterparties/);
  });
});

describe('repid-preview — previewTier does not drift from the engine ladder', () => {
  it('agrees with computeTier at every boundary', () => {
    // Imported lazily: this is the one place the test touches the engine, and
    // the import must not happen before the env dummies above are set.
    const { computeTier } = require('../src/engine/repid-update');
    const boundaries = [0, 10, 499, 500, 999, 1000, 4999, 5000, 7999, 8000, 10000];
    for (const score of boundaries) {
      expect(previewTier(score)).toBe(computeTier(score));
    }
  });
});
