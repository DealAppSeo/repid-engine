import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('sim-repid-aware', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-repid-aware.mjs');

  it('prints arm, verdict, and refuse as NOT_CHECKED until a calls file exists', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe(
      'arm\tverdict\trefuse\n' +
        'A\tNOT_CHECKED\tNOT_CHECKED\n' +
        'B\tNOT_CHECKED\tNOT_CHECKED\n' +
        'C\tNOT_CHECKED\tNOT_CHECKED\n',
    );
    for (const line of out.trim().split(/\r?\n/)) {
      expect(line.split('\t')).not.toContain('0');
    }
    expect(out).not.toContain('bare');
    expect(out).not.toContain('check-this');
    expect(out).not.toContain('later-rater');
  });

  it('reads the arm prompts on the fixture run and does not call a vendor', () => {
    const src = readFileSync(script, 'utf8');
    const arms = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-aware-arms.json'), 'utf8'),
    ) as { arms: { arm: string; prompt: string }[] };
    expect(arms.arms.map((row) => [row.arm, row.prompt])).toEqual([
      ['A', 'bare'],
      ['B', 'check-this'],
      ['C', 'later-rater'],
    ]);
    for (const row of arms.arms) {
      expect(row.prompt.includes('.')).toBe(false);
      expect(row.prompt.includes(' ')).toBe(false);
    }
    expect(src).toContain('repid-aware-arms.json');
    expect(src).toContain('later-rater');
    expect(src).toContain('error_rate');
    expect(src).toContain('refuse_rate');
    expect(src).toContain('same_direction_miss');
    expect(src).toContain("'NOT_CHECKED'");
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('hal-traps.json');
    const branch = src.slice(src.indexOf('const callsArg'));
    const ifBlock = branch.slice(branch.indexOf('if (callsArg)'), branch.indexOf('} else {'));
    expect(ifBlock).toContain('printCalls(');
    expect(ifBlock).not.toContain('armsPath');
    expect(ifBlock).not.toContain('repid-aware-arms.json');
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
