import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('t12 night queue', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 't12-night-queue.mjs');
  const sink = path.join(tmpdir(), `t12-night-${process.pid}.jsonl`);

  function run(flag: string | undefined, withSink: boolean): string {
    const env = { ...process.env };
    if (flag === undefined) delete env.T12_FREE_WAVE;
    else env.T12_FREE_WAVE = flag;
    const args = [script];
    if (withSink) args.push(sink);
    return execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', env });
  }

  afterEach(() => {
    if (existsSync(sink)) unlinkSync(sink);
  });

  it('prints skipped and writes nothing unless the flag is exact true', () => {
    for (const flag of [undefined, '', 'TRUE', 'True', '1', 'on', ' true']) {
      if (existsSync(sink)) unlinkSync(sink);
      const out = run(flag, true);
      expect(out).toBe('skipped\n');
      expect(existsSync(sink)).toBe(false);
    }
  });

  it('inserts the five fixture rows when the flag is exact true', () => {
    const out = run('true', true);
    expect(out).toBe('inserted\t5\n');
    const rows = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; claim: string; expected: string; source: string });
    expect(rows.map((row) => row.id)).toEqual([
      'water-boil',
      'four-chambers',
      'bitcoin-musk',
      'surgeon',
      'missing-dollar',
    ]);
    for (const row of rows) {
      expect(row.claim.length).toBeGreaterThan(0);
      expect(['PASS', 'VETO']).toContain(row.expected);
      expect(row.source).toBe('t12-night');
      expect(row).not.toHaveProperty('user_id');
    }
    expect(rows.filter((row) => row.expected === 'PASS').length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.expected === 'VETO').length).toBeGreaterThan(0);
  });

  it('does not open a database or a paid host', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('REAL_STAKING');
  });
});
