/**
 * witness-exclusion.fixture.ts — COMPILE-TIME evidence for the disclosure seam's public surface.
 *
 * ⚠ THIS FILE IS NOT MEANT TO COMPILE. It is input to `tests/zkrepid-witness-exclusion.test.ts`,
 * which runs the real TypeScript compiler over it and asserts that an error is reported on every
 * line tagged `@EXPECT_TS_ERROR` and on no other line.
 *
 * WHY A FIXTURE INSTEAD OF `@ts-expect-error` IN THE TEST FILE
 * ------------------------------------------------------------
 * The obvious way to test a compile-time guarantee is `@ts-expect-error` in the test itself. That
 * was tried on 2026-08-17 and MEASURED AS INERT: `jest.config.js` uses the stock `ts-jest` preset
 * with no `diagnostics` setting, and a deliberately bogus `@ts-expect-error` placed on an
 * error-free line left the suite GREEN (43/43). Nothing in this repo typechecks `tests/` either —
 * `tsconfig.json` sets `include: ["src/**\/*"]` and `exclude: ["tests", ...]`.
 *
 * So a `@ts-expect-error` here would have been a test that cannot fail (LESSONS §6): it would have
 * reported a protection nobody was checking. Running `tsc` and reading its output is the only way
 * to make this claim self-checking, so that is what the paired test does.
 *
 * Every declaration is exported: `isolatedModules` is on, and an unused local would otherwise be
 * noise in the compiler output the test parses.
 */

import type { ThresholdPublicInputs } from '../../src/zkrepid/disclosure';

const epoch = {
  label: '2026-08-17',
  start: '2026-08-17T00:00:00.000Z',
  end: '2026-08-18T00:00:00.000Z',
  root: '0x' + 'ab'.repeat(32),
};

const base = {
  threshold: 5000,
  formula_version: 'repid-delta-a8-quality-oriented',
  epoch,
  nullifier: '0x' + '3c'.repeat(32),
  digest: '0x' + '11'.repeat(32),
};

/**
 * THE CONTROL. A surface with exactly the pinned key set must still compile cleanly. Without this,
 * a `ForbiddenWitnessFields` broad enough to reject everything would pass every negative case and
 * the guard would look strongest at the moment it became useless.
 */
export const legal: ThresholdPublicInputs = { ...base };

/** The score itself — the one value the entire seam exists to keep off the wire. */
// @EXPECT_TS_ERROR repid_score
export const withScore: ThresholdPublicInputs = { ...base, repid_score: 6000 };

/** camelCase spelling of the same leak. */
// @EXPECT_TS_ERROR repidScore
export const withScoreCamel: ThresholdPublicInputs = { ...base, repidScore: 6000 };

/** A tier is a score band: publishing it narrows the score to roughly one of five. */
// @EXPECT_TS_ERROR tier
export const withTier: ThresholdPublicInputs = { ...base, tier: 'AUTONOMOUS' };

/** Re-identification. The scoped nullifier is the only identity handle on this surface. */
// @EXPECT_TS_ERROR agent_id
export const withAgentId: ThresholdPublicInputs = { ...base, agent_id: 'agent-1' };

/** The proven predicate. Holder-facing only until a circuit actually proves it. */
// @EXPECT_TS_ERROR met
export const withMet: ThresholdPublicInputs = { ...base, met: true };

/** The identity secret backing the nullifier. */
// @EXPECT_TS_ERROR identitySecret
export const withSecret: ThresholdPublicInputs = { ...base, identitySecret: { felts: [1n] } };

/**
 * THE CASE A PLAIN INTERFACE WOULD MISS — and the one that isolates `ForbiddenWitnessFields`.
 *
 * TypeScript's excess-property check only fires on a fresh object literal assigned directly to an
 * annotated target. Widening through an alias bypasses it entirely — which is how real code leaks,
 * because real code builds an object, passes it around, and annotates it somewhere else. Typing the
 * forbidden keys as `never` does not care how the object was constructed: `number` is not
 * assignable to `undefined`, wherever the value came from.
 *
 * ⚠ MEASURED 2026-08-17 — WHICH CASE ACTUALLY PROVES WHAT. `'repid_score'` was deleted from
 * `WitnessKey` to check that this suite can fail. ONLY THIS CASE WENT RED. Every literal case above
 * still errored, because a fresh object literal is independently caught by excess-property
 * checking, which needs no `never` typing at all.
 *
 * So the literal cases are defended twice and cannot distinguish the two mechanisms; THIS case is
 * the sole canary for `ForbiddenWitnessFields` itself. Do not delete it as redundant with the
 * others — it is the only one of them that is load-bearing, and the others would keep passing
 * after the guard it tests had been removed entirely.
 */
const wide = { ...base, repid_score: 6000 };
// @EXPECT_TS_ERROR aliased-spread
export const leakedThroughAlias: ThresholdPublicInputs = wide;
