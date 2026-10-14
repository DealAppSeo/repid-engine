/**
 * The daily state snapshot's DB credential (scripts/dispatch/db-creds.js).
 *
 * From 2026-10-12 every run failed with "Legacy API keys are disabled": the snapshot accepted only
 * a legacy service_role JWT. It now uses the engine's canonical SUPABASE_SECRET_KEY (sb_secret_…),
 * else DATABASE_URL, and with neither it names exactly what to set. No real key appears here.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveDbCreds, NO_CREDS, DEFAULT_SUPABASE_URL } = require('../scripts/dispatch/db-creds.js');

const SECRET = 'sb_secret_' + 'x'.repeat(24); // shape only, not a real key
const JWT = 'eyJ' + 'a'.repeat(30);
const PG = 'postgresql://localhost:6543/postgres';

describe('daily state DB credential', () => {
  it('uses SUPABASE_SECRET_KEY (sb_secret_…) via REST, like the engine', () => {
    expect(resolveDbCreds({ SUPABASE_SECRET_KEY: SECRET })).toEqual({ mode: 'rest', supaUrl: DEFAULT_SUPABASE_URL, key: SECRET });
  });

  it('prefers SUPABASE_SECRET_KEY over DATABASE_URL', () => {
    expect(resolveDbCreds({ SUPABASE_SECRET_KEY: SECRET, DATABASE_URL: PG }).mode).toBe('rest');
  });

  it('falls back to DATABASE_URL via pg', () => {
    expect(resolveDbCreds({ DATABASE_URL: PG })).toEqual({ mode: 'pg', url: PG });
  });

  it('reads .env.master when the process env has neither', () => {
    const fromFile = (n: string) => (n === 'SUPABASE_SECRET_KEY' ? SECRET : null);
    expect(resolveDbCreds({}, fromFile).mode).toBe('rest');
  });

  it('never uses a legacy JWT, and says so', () => {
    const r = resolveDbCreds({ SUPABASE_SERVICE_ROLE_KEY: JWT, SUPABASE_SERVICE_KEY: JWT });
    expect(r.mode).toBe('none');
    expect(r.why).toContain('SUPABASE_SECRET_KEY');
    expect(r.why).toContain('found only legacy SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SERVICE_KEY');
  });

  it('a SUPABASE_SECRET_KEY that is not sb_secret_… is refused with a precise reason', () => {
    const r = resolveDbCreds({ SUPABASE_SECRET_KEY: JWT });
    expect(r.mode).toBe('none');
    expect(r.why).toMatch(/not an sb_secret_/);
  });

  it('nothing set → the exact NO_CREDS message, never a silent skip', () => {
    expect(resolveDbCreds({})).toEqual({ mode: 'none', why: NO_CREDS });
  });

  it('honours SUPABASE_URL when set', () => {
    expect(resolveDbCreds({ SUPABASE_SECRET_KEY: SECRET, SUPABASE_URL: 'http://127.0.0.1:54321' }).supaUrl).toBe('http://127.0.0.1:54321');
  });
});
