/**
 * E6 — C9/C10 writes only on scratch DB. No prod backfill.
 */
import { identityWritesEnabled } from '../src/identity/public-fields';

describe('E6 identity writes flag', () => {
  it('is off in a hosted process (no LOCAL_MODE, no IDENTITY_FEATURES=enforce)', () => {
    expect(identityWritesEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(identityWritesEnabled({ LOCAL_MODE: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is on for scratch LOCAL_MODE', () => {
    expect(identityWritesEnabled({ LOCAL_MODE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('IDENTITY_FEATURES=off wins even in LOCAL_MODE', () => {
    expect(
      identityWritesEnabled({ LOCAL_MODE: 'true', IDENTITY_FEATURES: 'off' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
