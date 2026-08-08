/**
 * LOCAL_MODE lets the engine BOOT without a hosted Supabase.
 *
 * The bug this pins the fix for: src/config.ts throws at import time when
 * SUPABASE_URL / a service key is absent, so a fresh clone with no hosted DB
 * cannot come up at all. LOCAL_MODE backfills a loopback default instead of
 * throwing — and, critically, the hosted contract is preserved: with LOCAL_MODE
 * off, the same throw still fires.
 *
 * Uses jest.resetModules + env save/restore so each case imports config fresh.
 */
const SUPABASE_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_KEY',
  'LOCAL_MODE',
  'ONLY_ATTESTATIONS_LEAVE',
  'LOCAL_LLM_BASE_URL',
  'OPENAI_BASE_URL',
];

describe('config LOCAL_MODE boot', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.resetModules();
    for (const k of SUPABASE_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of SUPABASE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('HOSTED CONTRACT PRESERVED: with LOCAL_MODE off and no SUPABASE_URL, import THROWS', () => {
    // LOCAL_MODE unset, no supabase creds.
    expect(() => require('../src/config')).toThrow(/SUPABASE_URL/);
  });

  test('LOCAL_MODE=true boots with NO hosted Supabase (no throw) and a loopback default', () => {
    process.env.LOCAL_MODE = 'true';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let mod: any;
    expect(() => {
      mod = require('../src/config');
    }).not.toThrow();
    expect(mod.LOCAL_MODE).toBe(true);
    expect(mod.config.supabaseUrl).toBe('http://127.0.0.1:54321');
    expect(typeof mod.config.supabaseKey).toBe('string');
    expect(mod.config.supabaseKey.length).toBeGreaterThan(0);
    // NO SILENT DEGRADATION: the local boot is announced loudly.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls.map((c: any[]) => c.join(' ')).join(' '))).toMatch(/LOCAL_MODE/);
    warn.mockRestore();
  });

  test('a real SUPABASE_URL still wins in LOCAL_MODE (loopback default is only a fallback)', () => {
    process.env.LOCAL_MODE = 'true';
    process.env.SUPABASE_URL = 'https://real-project.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'real-key';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = require('../src/config');
    expect(mod.config.supabaseUrl).toBe('https://real-project.supabase.co');
    warn.mockRestore();
  });

  test('boundary flags parse from env', () => {
    process.env.LOCAL_MODE = 'true';
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434/v1';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = require('../src/config');
    expect(mod.ONLY_ATTESTATIONS_LEAVE).toBe(true);
    expect(mod.LOCAL_LLM_BASE_URL).toBe('http://localhost:11434/v1');
    warn.mockRestore();
  });
});
