import { findEnvTypos } from '../src/config/env-typo-guard';

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

  it('never throws, even against the full generated registry', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { KNOWN_ENV_VARS } = require('../src/config/known-env-vars.generated');
    expect(() => findEnvTypos(Object.keys(process.env), KNOWN_ENV_VARS)).not.toThrow();
  });
});
