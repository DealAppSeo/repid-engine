import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findEnvTypos, ALL_KNOWN_ENV_VARS, scanNamedTokens, unreadEnvReport, reportUnreadEnvNames } from '../src/config/env-typo-guard';
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

describe('unread variable names (names only)', () => {
  const named = new Set(['SUPABASE_URL', 'HAL_STRICTNESS']);

  it('lists a set name that no code names, and only that one', () => {
    const line = unreadEnvReport(['SUPABASE_URL', 'HAL_STRICTNESS', 'LEFTOVER_OLD_SWITCH'], named);
    expect(line).toContain("1 set variable(s) that this repo's code never names: LEFTOVER_OLD_SWITCH.");
    expect(line).toContain('Libraries and names built at runtime are not seen, so check before deleting.');
  });

  it('counts a registry name as read even when the scan did not see it', () => {
    const composed = ALL_KNOWN_ENV_VARS[ALL_KNOWN_ENV_VARS.length - 1]!;
    expect(unreadEnvReport(['SUPABASE_URL', composed], named)).toContain('no set variable is unread');
  });

  it('leaves out names the platform injects', () => {
    const line = unreadEnvReport(['SUPABASE_URL', 'RAILWAY_ENVIRONMENT', 'PATH', 'npm_config_cache', 'NODE_ENV'], named);
    expect(line).toContain('no set variable is unread');
    expect(line).toContain("all 1 non-platform names appear in this repo's code (4 platform names skipped)");
  });

  it('counts an odd-format name but never prints it', () => {
    const line = unreadEnvReport(['SUPABASE_URL', 'weird-name=sk_live_abc'], named);
    expect(line).toContain('Plus 1 name(s) in an unusual format, not printed.');
    expect(line).not.toContain('weird');
    expect(line).not.toContain('sk_live');
  });

  it('says NOT_CHECKED, and lists nothing, when the scan cannot see the control name', () => {
    const line = unreadEnvReport(['LEFTOVER_OLD_SWITCH'], new Set(['HAL_STRICTNESS']));
    expect(line).toContain('NOT_CHECKED');
    expect(line).not.toContain('LEFTOVER_OLD_SWITCH');
  });

  it('reads names from code files, comments included, but not from docs or node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-unread-'));
    try {
      writeFileSync(join(dir, 'a.ts'), '// mentions ALPHA_ONE\nconst x = process.env.BETA_TWO;\n');
      writeFileSync(join(dir, 'b.md'), 'GAMMA_THREE\n');
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', 'c.js'), 'DELTA_FOUR\n');
      const got = await scanNamedTokens([dir]);
      expect(got.has('ALPHA_ONE')).toBe(true);
      expect(got.has('BETA_TWO')).toBe(true);
      expect(got.has('GAMMA_THREE')).toBe(false);
      expect(got.has('DELTA_FOUR')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on this repo, finds the control and a name read only through a helper', async () => {
    const got = await scanNamedTokens([join(__dirname, '..', 'src'), join(__dirname, '..', 'scripts')]);
    expect(got.has('SUPABASE_URL')).toBe(true);
    expect(got.has('HAL_PERSIST_RULER')).toBe(true); // read as envTrue('...'), not process.env.X
    expect(got.has('ZZ_NOT_A_NAME_ANYWHERE_0')).toBe(false);
  });

  it('end to end: scans the given roots, reads only process.env keys, and logs one line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-unread-e2e-'));
    const saved = { ...process.env };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeFileSync(join(dir, 'config.js'), 'const u = process.env.SUPABASE_URL;\n');
      process.env.SUPABASE_URL = 'http://localhost:54321';
      process.env.LEFTOVER_E2E_SWITCH = 'secret-value-must-not-print';
      await reportUnreadEnvNames([dir]);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('LEFTOVER_E2E_SWITCH');
      expect(line).not.toContain('secret-value-must-not-print');

      warn.mockClear();
      await reportUnreadEnvNames([join(dir, 'missing')]); // a scan that sees nothing
      expect(String(warn.mock.calls[0]![0])).toContain('NOT_CHECKED');
    } finally {
      warn.mockRestore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
