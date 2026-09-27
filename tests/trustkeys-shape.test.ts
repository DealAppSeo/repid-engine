import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('trustkeys-shape', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'trustkeys-shape.mjs');
  const sentinel = 'sb_secret_SHAPE_SENTINEL';
  const database = 'postgresql://shape-user:shape-pass@example.invalid/db';
  const other = 'not-a-matching-shape';

  function run(extra: Record<string, string>) {
    return execFileSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...extra,
      },
    });
  }

  it('prints names and shapes and does not print values', () => {
    const out = run({
      SUPABASE_SECRET_KEY: sentinel,
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_SERVICE_KEY: other,
      DATABASE_URL: database,
    });
    expect(out).toBe(
      [
        'SUPABASE_SECRET_KEY\tsb_secret',
        'SUPABASE_SERVICE_ROLE_KEY\tunset',
        'SUPABASE_SERVICE_KEY\tother',
        'DATABASE_URL\tpostgresql',
      ].join('\n') + '\n',
    );
    expect(out).not.toContain(sentinel);
    expect(out).not.toContain(other);
    expect(out).not.toContain('shape-pass');
    expect(out).not.toContain('shape-user');
    expect(out).not.toContain('postgresql://');
    expect(out).not.toContain('postgres://');
  });

  it('accepts a postgres scheme without printing it', () => {
    const url = 'postgres://shape-user:shape-pass@example.invalid/db';
    const out = run({ DATABASE_URL: url });
    expect(out).toContain('DATABASE_URL\tpostgresql');
    expect(out).not.toContain(url);
    expect(out).not.toContain('shape-pass');
  });

  it('does not read a file and does not insert', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('sb_secret_');
    expect(src).toContain('postgresql://');
    expect(src).not.toContain('readFileSync');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
  });
});
