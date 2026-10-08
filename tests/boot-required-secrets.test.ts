/**
 * [Sean 2026-10-08] "If CONTROLLER_QR_SECRET or ORACLE_HMAC_SECRET is unset, the process refuses to
 * start." This is the test for that miss. assertRequiredSecrets throws when either is unset; the
 * server entry calls it before app.listen, inside the `if (!IS_TEST)` block, so production refuses
 * and Jest (NODE_ENV=test) is unaffected.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assertRequiredSecrets,
  MissingRequiredSecretsError,
  REQUIRED_AT_BOOT,
} from '../src/config/required-secrets';

const bothSet = { CONTROLLER_QR_SECRET: 'x', ORACLE_HMAC_SECRET: 'y' } as NodeJS.ProcessEnv;

describe('the API refuses to boot without its required secrets', () => {
  it('both set: it does not throw', () => {
    expect(() => assertRequiredSecrets(bothSet)).not.toThrow();
  });

  it('CONTROLLER_QR_SECRET unset: throws, naming it', () => {
    const env = { ...bothSet, CONTROLLER_QR_SECRET: undefined } as NodeJS.ProcessEnv;
    expect(() => assertRequiredSecrets(env)).toThrow(/CONTROLLER_QR_SECRET/);
  });

  it('ORACLE_HMAC_SECRET unset: throws, naming it', () => {
    const env = { ...bothSet, ORACLE_HMAC_SECRET: undefined } as NodeJS.ProcessEnv;
    expect(() => assertRequiredSecrets(env)).toThrow(/ORACLE_HMAC_SECRET/);
  });

  it('a blank or whitespace value counts as unset', () => {
    expect(() => assertRequiredSecrets({ CONTROLLER_QR_SECRET: '   ', ORACLE_HMAC_SECRET: 'y' } as NodeJS.ProcessEnv))
      .toThrow(/CONTROLLER_QR_SECRET/);
  });

  it('both unset: one boot attempt names the whole set, not just the first', () => {
    let err: unknown;
    try {
      assertRequiredSecrets({} as NodeJS.ProcessEnv);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingRequiredSecretsError);
    expect((err as MissingRequiredSecretsError).missing.sort()).toEqual(
      ['CONTROLLER_QR_SECRET', 'ORACLE_HMAC_SECRET'],
    );
  });

  it('every required name carries a reason, for the boot error and this test', () => {
    for (const name of Object.keys(REQUIRED_AT_BOOT)) {
      expect(REQUIRED_AT_BOOT[name]!.length).toBeGreaterThan(10);
    }
  });

  it('the server entry calls the check before it listens, and only outside test', () => {
    const raw = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    // Strip line comments first: a commented-out `// assertRequiredSecrets();` is not a call, and a
    // test that matched it would pass with the wiring removed (measured — that was the first version).
    const src = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const guard = src.indexOf('if (!IS_TEST) {');
    const call = src.indexOf('assertRequiredSecrets();');
    const listen = src.indexOf('app.listen(');
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
    expect(listen).toBeGreaterThan(call);
  });
});
