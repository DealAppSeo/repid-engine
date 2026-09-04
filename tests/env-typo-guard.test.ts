import { findEnvTypos, ALL_KNOWN_ENV_VARS } from '../src/config/env-typo-guard';
import { SURFACE_ENV_NAMES, SURFACES } from '../src/resilience/decision-contract';

describe('findEnvTypos', () => {
  const known = ['HAL_PUBLIC_RATE_LIMIT', 'HAL_BYOK_DAILY', 'PORT'];

  it('flags a 1-edit-distance typo whose canonical name is unset', () => {
    const warnings = findEnvTypos(['HAL_PBLIC_RATE_LIMIT'], known);
    expect(warnings).toEqual([
      { set: 'HAL_PBLIC_RATE_LIMIT', suggested: 'HAL_PUBLIC_RATE_LIMIT', distance: 1 },
    ]);
  });

  it('flags a substituted-character typo (K -> C)', () => {
    const warnings = findEnvTypos(['HAL_BYOC_DAILY'], known);
    expect(warnings).toEqual([
      { set: 'HAL_BYOC_DAILY', suggested: 'HAL_BYOK_DAILY', distance: 1 },
    ]);
  });

  it('does not flag an exact match', () => {
    expect(findEnvTypos(['HAL_PUBLIC_RATE_LIMIT'], known)).toEqual([]);
  });

  it('does not flag a near-miss when the canonical name is ALSO set (intentional alias)', () => {
    const warnings = findEnvTypos(['HAL_PBLIC_RATE_LIMIT', 'HAL_PUBLIC_RATE_LIMIT'], known);
    expect(warnings).toEqual([]);
  });

  it('does not flag unrelated short names', () => {
    expect(findEnvTypos(['CI', 'PATH', 'HOME', 'NODE_ENV'], known)).toEqual([]);
  });

  it('ignores known names shorter than the minimum comparison length', () => {
    // "PORT" (4 chars) is below MIN_NAME_LENGTH — too short to compare safely.
    expect(findEnvTypos(['PROT'], known)).toEqual([]);
  });

  describe('names this codebase COMPOSES at runtime', () => {
    // The generated registry is built by static analysis of literal
    // `process.env.NAME` reads, so a name assembled from a template string is
    // invisible to it — its own header calls that an accepted gap. Fourteen of
    // these sixteen fell into it, including the flag that lets the resilience
    // brain actuate on PAYMENTS.
    it('covers every enable/shadow name for every surface', () => {
      expect(SURFACE_ENV_NAMES).toHaveLength(SURFACES.length * 2);
      for (const name of SURFACE_ENV_NAMES) expect(ALL_KNOWN_ENV_VARS).toContain(name);
    });

    it('catches a typo the generated registry alone is blind to', () => {
      // THIS IS THE WHOLE POINT, so it is asserted as a BEFORE/AFTER pair rather
      // than as one green expectation. Against the generated list alone the typo
      // is near-miss of nothing it knows, so the guard says nothing at all and
      // the surface silently never actuates — while a variable sits in the
      // dashboard proving to the operator that it does.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { KNOWN_ENV_VARS } = require('../src/config/known-env-vars.generated');
      const typo = 'RESILIENCE_ANFIS_ENABLE_PAYMNETS';

      expect(findEnvTypos([typo], KNOWN_ENV_VARS)).toEqual([]); // the old blindness
      expect(findEnvTypos([typo])).toEqual([
        { set: typo, suggested: 'RESILIENCE_ANFIS_ENABLE_PAYMENTS', distance: 2 },
      ]);
    });

    it('does not false-positive on a correctly spelled composed name', () => {
      // A guard that cries wolf on correct configuration gets switched off, and
      // then it is not a guard.
      for (const name of SURFACE_ENV_NAMES) expect(findEnvTypos([name])).toEqual([]);
    });
  });

  it('never throws, even against the full generated registry', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { KNOWN_ENV_VARS } = require('../src/config/known-env-vars.generated');
    expect(() => findEnvTypos(Object.keys(process.env), KNOWN_ENV_VARS)).not.toThrow();
  });
});
