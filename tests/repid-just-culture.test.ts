/**
 * JUST-CULTURE FENCE — a self-reported failure must cost strictly less than a detected one.
 *
 * WHAT WAS WRONG, measured against production 2026-08-11. Across 152,130 score events, all
 * eight negative event types are detection-shaped. An agent with something to disclose had no
 * channel, so concealment was not merely cheaper than disclosure — disclosure had no
 * representation at all, making concealment strictly dominant by construction.
 *
 * Meanwhile `repid_confession_log` sat in production with a complete schema — penalty_applied
 * AND reduced_penalty, hal_verified, probation_ends_at, peer_endorsement_required — holding
 * zero rows, with no writer anywhere in the codebase. Someone designed just culture properly
 * and nothing was ever wired to it. LESSONS #3: an unwired mechanism is worse than an absent
 * one, because a reviewer reading the schema concludes it is handled.
 *
 * WHY THE STRICT INEQUALITY NEEDS A TEST RATHER THAN A CONSTANT. The asymmetry is the entire
 * mechanism. A future tidy-up that "normalises the deltas" would return it to parity, and the
 * system would go back to punishing honesty at exactly the same rate as being caught —
 * silently, because every individual number would still look reasonable.
 */
// The service imports ../db for its writers; db.ts throws without SUPABASE creds. These
// cases exercise the PURE asymmetry and the wiring, so the client is mocked rather than
// requiring credentials to assert that confession is cheaper than getting caught.
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  reducedPenalty,
  isStrictlyCheaper,
  validateConfession,
  SELF_REPORT_DISCOUNT,
  SELF_REPORTED_FAILURE,
} from '../src/services/repid-confession';
import { schemaAcceptsEventType } from './event-type-whitelist';

describe('the asymmetry holds across the whole realistic penalty range', () => {
  // Real detected penalties observed in production, by event type:
  //   VALIDATION_FAILED -101 (max -250) · EPISTEMIC_VIOLATION -60 · CHALLENGE_LOSS -31
  //   VALIDATOR_PENALTY -5 · HAL_SCORE_EVENT -4.6 (max -10) · DORMANCY_DECAY -3
  const REAL_PENALTIES = [250, 101, 75, 60, 50, 45, 31, 21, 10, 8, 5, 3, 2];

  test.each(REAL_PENALTIES)('detected %i → confession is strictly cheaper', (detected) => {
    const r = reducedPenalty(detected);
    expect(`${detected}: reduced=${r.reduced}`).toBe(`${detected}: reduced=${Math.ceil(detected * SELF_REPORT_DISCOUNT)}`);
    expect(r.reduced).toBeLessThan(r.detected);
    expect(isStrictlyCheaper(r)).toBe(true);
  });

  test('the delta is negative — confessing still costs something', () => {
    for (const p of REAL_PENALTIES) {
      const r = reducedPenalty(p);
      expect(r.delta).toBeLessThan(0);
    }
  });

  test('confession is never FREE — that would price in reputation laundering', () => {
    for (const p of [1, 2, 3, 5, 250]) {
      expect(reducedPenalty(p).reduced).toBeGreaterThanOrEqual(1);
    }
  });

  test('the one degenerate case is REPORTED, not hidden', () => {
    // A 1-point penalty cannot be strictly cheaper while staying >= 1. The function says so
    // rather than quietly rounding to zero or pretending the discount applied.
    const r = reducedPenalty(1);
    expect(r.detected).toBe(1);
    expect(r.reduced).toBe(1);
    expect(isStrictlyCheaper(r)).toBe(false);
  });

  test('a zero penalty stays zero and claims no discount', () => {
    const r = reducedPenalty(0);
    expect(r).toEqual({ detected: 0, reduced: 0, delta: 0 });
    expect(isStrictlyCheaper(r)).toBe(false);
  });

  test('sign of the input does not matter — callers pass magnitudes or deltas', () => {
    expect(reducedPenalty(-60)).toEqual(reducedPenalty(60));
  });
});

describe('the discount cannot drift back to parity', () => {
  // This is the guard against the tidy-up that quietly kills the mechanism.
  test('SELF_REPORT_DISCOUNT is strictly between 0 and 1', () => {
    expect(SELF_REPORT_DISCOUNT).toBeGreaterThan(0);
    expect(SELF_REPORT_DISCOUNT).toBeLessThan(1);
  });

  test('a discount of 1.0 would be caught — the fence can fail', () => {
    // Proving the assertion has teeth: at parity, isStrictlyCheaper must go false for every
    // realistic penalty, which is what the suite above would report.
    for (const p of [250, 101, 60, 10, 5]) {
      const parity = reducedPenalty(p, 1.0);
      expect(isStrictlyCheaper(parity)).toBe(false);
    }
  });

  test('a discount of 0 would be caught too — free confession is also wrong', () => {
    // Floor of 1 keeps it from reaching zero, so "free" is structurally impossible.
    expect(reducedPenalty(250, 0).reduced).toBe(1);
    expect(reducedPenalty(250, 0).reduced).toBeGreaterThan(0);
  });
});

describe('validation refuses incomplete confessions by name', () => {
  const base = { agentId: 'a', domain: 'd', confessionText: 't', detectedPenalty: 10 };
  test.each([
    ['AGENT_REQUIRED', { ...base, agentId: '' }],
    ['TEXT_REQUIRED', { ...base, confessionText: '   ' }],
    ['DOMAIN_REQUIRED', { ...base, domain: '' }],
    ['PENALTY_REQUIRED', { ...base, detectedPenalty: Number.NaN }],
  ])('%s', (expected, input) => {
    expect(validateConfession(input as never)).toBe(expected);
  });

  test('a complete confession validates', () => {
    expect(validateConfession(base)).toBeNull();
  });
});

describe('the mechanism has a caller — it is not another empty table', () => {
  // The entire point of this change. A service with no route would reproduce, one layer up,
  // the exact failure it was written to fix.
  const SRC = path.resolve(__dirname, '..', 'src');

  test('a route imports recordConfession', () => {
    const route = readFileSync(path.join(SRC, 'routes/repid-confess.ts'), 'utf8');
    expect(route).toMatch(/recordConfession/);
    expect(route).toMatch(/repid\/:agentId\/confess/);
  });

  test('the route is mounted in index.ts', () => {
    const index = readFileSync(path.join(SRC, 'index.ts'), 'utf8');
    expect(index).toMatch(/repidConfessRouter/);
    expect(index).toMatch(/app\.use\('\/api\/v1', repidConfessRouter\)/);
  });

  test('it is mounted AFTER authMiddleware — confession must come from the agent itself', () => {
    // An unauthenticated confession endpoint lets anyone charge anyone else a penalty.
    const lines = readFileSync(path.join(SRC, 'index.ts'), 'utf8').split('\n');
    const auth = lines.findIndex((l) => /^app\.use\(authMiddleware\)/.test(l));
    const mount = lines.findIndex((l) => /app\.use\('\/api\/v1', repidConfessRouter\)/.test(l));
    expect(auth).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(-1);
    expect(`confess mounted at ${mount} vs auth at ${auth}`).toBe(
      mount > auth ? `confess mounted at ${mount} vs auth at ${auth}` : 'confess route is PUBLIC — anyone could penalise anyone',
    );
  });

  test('the service writes to the table that has been empty all along', () => {
    const svc = readFileSync(path.join(SRC, 'services/repid-confession.ts'), 'utf8');
    expect(svc).toMatch(/from\('repid_confession_log'\)/);
    expect(svc).toMatch(/\.insert\(/);
    // And both halves of the asymmetry are persisted, not just the charged one.
    expect(svc).toMatch(/penalty_applied/);
    expect(svc).toMatch(/reduced_penalty/);
  });

  test('the new event type is distinct from every detection-shaped one', () => {
    const DETECTION_SHAPED = [
      'VALIDATION_FAILED', 'EPISTEMIC_VIOLATION', 'CHALLENGE_LOSS',
      'VALIDATOR_PENALTY', 'HAL_SCORE_EVENT', 'DORMANCY_DECAY',
    ];
    expect(DETECTION_SHAPED).not.toContain(SELF_REPORTED_FAILURE);
    expect(SELF_REPORTED_FAILURE).toBe('SELF_REPORTED_FAILURE');
  });

  /**
   * THE GAP THAT LET THIS SHIP. The assertion above checks the event type is
   * distinct from every detection-shaped one. Nothing checked the DATABASE would
   * accept it — and it did not.
   *
   * MEASURED 2026-08-21 in a rolled-back transaction: an insert carrying this
   * event type was rejected `23514 check_violation`. So `recordConfession()`
   * wrote its confession-log row, the ledger write failed, and the function
   * returned `ok: true` with the failure demoted to a `warning` field. An agent
   * confessed and its score did not move.
   *
   * That makes confession FREE, which is worse than the parity case: this
   * module's own header states that a discount of `0` "prices in reputation
   * laundering", and the invariant test two files over pins the discount
   * strictly between 0 and 1 — while the effective discount in production was 0.
   *
   * Fixed by adding the value to the constraint. A name is not a channel, and a
   * mechanism nothing has ever exercised is not a mechanism.
   */
  test('the schema will actually accept the event type the confession path writes', () => {
    expect(schemaAcceptsEventType(SELF_REPORTED_FAILURE)).toBe(true);
  });
});

describe('confession ordering survives a partial failure', () => {
  // The confession log is written FIRST on purpose: if the ledger write then fails, the
  // disclosure still exists. Charging an agent for honesty while keeping no record of the
  // honesty is the worst available failure for this mechanism.
  test('the source writes confession_log before the ledger', () => {
    // Keyed on `insertScoreEvent(` rather than a raw table name: the ledger write goes
    // through the guarded writer now. This assertion previously matched the raw insert and
    // broke when the service was corrected — the property was right, the probe was pinned to
    // an implementation detail that changed.
    const svc = readFileSync(path.resolve(__dirname, '../src/services/repid-confession.ts'), 'utf8');
    const body = svc.slice(svc.indexOf('export async function recordConfession'));
    const confIdx = body.indexOf("from('repid_confession_log')");
    const evIdx = body.indexOf('insertScoreEvent({');
    expect(confIdx).toBeGreaterThan(-1);
    expect(evIdx).toBeGreaterThan(-1);
    expect(`confession@${confIdx} before ledger@${evIdx}`).toBe(
      confIdx < evIdx ? `confession@${confIdx} before ledger@${evIdx}` : 'LEDGER WRITTEN FIRST — a lost confession would charge for honesty silently',
    );
  });

  test('the ledger write goes through the guarded writer, not a raw insert', () => {
    // The repo's ratchet caught the first version doing a raw insert. Pinned so it stays fixed.
    const svc = readFileSync(path.resolve(__dirname, '../src/services/repid-confession.ts'), 'utf8');
    expect(svc).toMatch(/import \{ insertScoreEvent \}/);
    expect(svc).toMatch(/applier: 'trigger'/);
  });

  test('an unverifiable confession requires peer endorsement', () => {
    // Confessing to something nothing observed is the shape of reputation laundering; the
    // original schema author anticipated it (false_confessions_flagged).
    const svc = readFileSync(path.resolve(__dirname, '../src/services/repid-confession.ts'), 'utf8');
    expect(svc).toMatch(/peer_endorsement_required: unverifiable/);
    expect(svc).toMatch(/hal_verified: false/);
  });
});
