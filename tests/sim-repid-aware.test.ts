import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('sim-repid-aware', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-repid-aware.mjs');

  it('prints arms A B C as FIXTURE until a calls file exists', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe(
      'arm\tA\tFIXTURE\n' +
        'arm\tB\tFIXTURE\n' +
        'arm\tC\tFIXTURE\n' +
        'error_rate\tNOT_CHECKED\n' +
        'refuse_rate\tNOT_CHECKED\n' +
        'same_direction_miss\tNOT_CHECKED\n',
    );
    for (const line of out.trim().split(/\r?\n/)) {
      expect(line.split('\t')).not.toContain('0');
    }
  });

  it('reads hal-traps on the fixture run and does not call a vendor', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('hal-traps.json');
    expect(src).toContain('FIXTURE');
    expect(src).toContain('error_rate');
    expect(src).toContain('refuse_rate');
    expect(src).toContain('same_direction_miss');
    expect(src).toContain("'NOT_CHECKED'");
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('process.env');
    const branch = src.slice(src.indexOf('const callsArg'));
    const ifBlock = branch.slice(branch.indexOf('if (callsArg)'), branch.indexOf('} else {'));
    expect(ifBlock).toContain('printCalls(');
    expect(ifBlock).not.toContain('trapsPath');
    expect(ifBlock).not.toContain('hal-traps.json');
    expect(branch).toContain('printFixture()');
  });

  it('scores a calls file and prints a missing family as NOT_CHECKED', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'repid-aware-'));
    const calls = path.join(dir, 'calls.json');
    writeFileSync(
      calls,
      JSON.stringify([
        { host: 'groq', arm: 'A', verdict: 'TRUE' },
        { family: 0, host: 'groq', arm: 'B', verdict: 'FALSE' },
        { family: 'llama', host: 'groq', arm: 'A', verdict: 'FALSE' },
        { family: 'llama', host: 'groq', arm: 'B', verdict: 'FALSE' },
        { family: 'qwen', host: 'cerebras', arm: 'C', verdict: 'TRUE' },
      ]),
    );
    try {
      const out = execFileSync(process.execPath, [script, calls], { cwd: root, encoding: 'utf8' });
      expect(out).toBe(
        'arm\tA\tNOT_CHECKED\tgroq\tTRUE\n' +
          'arm\tB\tNOT_CHECKED\tgroq\tFALSE\n' +
          'arm\tA\tllama\tgroq\tFALSE\n' +
          'arm\tB\tllama\tgroq\tFALSE\n' +
          'arm\tC\tqwen\tcerebras\tTRUE\n' +
          'error_rate\t67\n' +
          'refuse_rate\t40\n' +
          'same_direction_miss\t1\n',
      );
      expect(out).not.toContain('FIXTURE');
      expect(out).not.toContain("boy's mother");
      for (const line of out.trim().split(/\r?\n/)) {
        expect(line.split('\t')).not.toContain('0');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
