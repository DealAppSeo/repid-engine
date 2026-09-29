import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('trustkeys-shape exit', () => {
  const script = path.join(__dirname, '..', 'scripts', 'trustkeys-shape.mjs');
  const secret = 'sb_secret_SHAPE_SENTINEL';
  const database = 'postgresql://shape-user:shape-pass@example.invalid/db';

  function run(extra: Record<string, string>): { code: number; out: string } {
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ...extra,
    };
    try {
      const out = execFileSync(process.execPath, [script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env });
      return { code: 0, out };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      return { code: failed.status ?? 1, out: failed.stdout ?? '' };
    }
  }

  it('exits 2 when a name is unset and does not print a value', () => {
    const result = run({});
    expect(result.code).toBe(2);
    expect(result.out).toContain('SUPABASE_SECRET_KEY\tunset');
    expect(result.out).toContain('DATABASE_URL\tunset');
    expect(result.out).not.toContain(secret);
    expect(result.out).not.toContain('shape-pass');
  });

  it('exits 0 for sb_secret and postgresql and does not print the value', () => {
    const result = run({
      SUPABASE_SECRET_KEY: secret,
      SUPABASE_SERVICE_ROLE_KEY: secret,
      SUPABASE_SERVICE_KEY: 'sb_publishable_SHAPE_SENTINEL',
      DATABASE_URL: database,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('SUPABASE_SECRET_KEY\tsb_secret');
    expect(result.out).toContain('DATABASE_URL\tpostgresql');
    expect(result.out).not.toContain(secret);
    expect(result.out).not.toContain(database);
    expect(result.out).not.toContain('shape-pass');
    expect(result.out).not.toContain('sb_publishable_SHAPE_SENTINEL');
  });
});
