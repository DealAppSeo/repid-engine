import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('trustkeys-shape', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'trustkeys-shape.mjs');
  const secret = 'sb_secret_SHAPE_SENTINEL';
  const publishable = 'sb_publishable_SHAPE_SENTINEL';
  const jwt = 'eyJhbGciOiJub25lIn0.e30.sig';
  const database = 'postgresql://shape-user:shape-pass@example.invalid/db';
  const other = 'not-a-matching-shape';

  function run(extra: Record<string, string>): { code: number; out: string; err: string } {
    try {
      const out = execFileSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ...extra,
        },
      });
      return { code: 0, out, err: '' };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string };
      return {
        code: failed.status ?? 1,
        out: failed.stdout ?? '',
        err: failed.stderr ?? '',
      };
    }
  }

  function known(): Record<string, string> {
    return {
      SUPABASE_SECRET_KEY: secret,
      SUPABASE_SERVICE_ROLE_KEY: publishable,
      SUPABASE_SERVICE_KEY: jwt,
      DATABASE_URL: database,
      SUPABASE_PUBLISHABLE_KEY: publishable,
    };
  }

  it('exits 0 for known shapes and does not print values', () => {
    const result = run(known());
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(
      [
        'SUPABASE_SECRET_KEY\tsb_secret',
        'SUPABASE_SERVICE_ROLE_KEY\tsb_publishable',
        'SUPABASE_SERVICE_KEY\tjwt_eyJ',
        'DATABASE_URL\tpostgresql',
        'SUPABASE_PUBLISHABLE_KEY\tsb_publishable',
      ].join('\n') + '\n',
    );
    expect(result.out).not.toContain(secret);
    expect(result.out).not.toContain(publishable);
    expect(result.out).not.toContain(jwt);
    expect(result.out).not.toContain('shape-pass');
    expect(result.out).not.toContain('shape-user');
    expect(result.out).not.toContain('postgresql://');
    expect(result.out).not.toContain('postgres://');
  });

  it('exits 2 when a name is unset and still prints only the shape', () => {
    const result = run({ ...known(), SUPABASE_SERVICE_ROLE_KEY: '' });
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    expect(result.out).toContain('SUPABASE_SERVICE_ROLE_KEY\tunset');
    expect(result.out).not.toContain(secret);
    expect(result.out).not.toContain(jwt);
  });

  it('exits 2 on other and does not print the value', () => {
    const result = run({ ...known(), SUPABASE_SERVICE_KEY: other });
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    expect(result.out).toContain('SUPABASE_SERVICE_KEY\tother');
    expect(result.out).not.toContain(other);
  });

  it('accepts a postgres scheme without printing it', () => {
    const url = 'postgres://shape-user:shape-pass@example.invalid/db';
    const result = run({ ...known(), DATABASE_URL: url });
    expect(result.code).toBe(0);
    expect(result.out).toContain('DATABASE_URL\tpostgresql');
    expect(result.out).not.toContain(url);
    expect(result.out).not.toContain('shape-pass');
  });

  it('does not read a file and does not insert', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('sb_secret_');
    expect(src).toContain('sb_publishable_');
    expect(src).toContain('postgresql://');
    expect(src).toContain('eyJ');
    expect(src).not.toContain('readFileSync');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
  });
});
