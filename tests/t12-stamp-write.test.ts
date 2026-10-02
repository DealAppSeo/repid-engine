import { readFileSync } from 'node:fs';
import path from 'node:path';
import { printT12TrapTable, readT12Stamp, scoreAfterStampRow, writeT12Stamp } from '../src/orchestration/t12-stamp-write';

describe('T12 stamp writer', () => {
  it('writes caught for a veto, pass for a pass, and NOT_CHECKED for a timeout', () => {
    const veto = writeT12Stamp({ verdict: 'veto', score: 3 });
    expect(veto.stamp).toBe('caught');
    expect(readT12Stamp(veto)).toBe('caught');
    expect(Object.keys(veto).sort()).toEqual(['score', 'stamp']);
    expect(JSON.stringify(veto)).not.toContain('user_id');

    const passed = writeT12Stamp({ verdict: 'pass', score: 2 });
    expect(passed.stamp).toBe('pass');
    expect(readT12Stamp(passed)).toBe('pass');

    const timed = writeT12Stamp({ verdict: 'pass', timeout: true, score: 4 });
    expect(timed.stamp).toBe('NOT_CHECKED');
    expect(timed.stamp).not.toBe(0);
    expect(readT12Stamp(timed)).toBe('NOT_CHECKED');

    const missing = writeT12Stamp({ score: undefined });
    expect(missing.score).toBe('NOT_CHECKED');
    expect(missing.score).not.toBe(0);
    const zero = writeT12Stamp({ verdict: 'veto', score: 0 });
    expect(zero.score).toBe('NOT_CHECKED');
    expect(zero.score).not.toBe(0);
    expect(zero.stamp).toBe('caught');
  });

  it('prints first-pass and post-check for the ten fixture claims', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'scripts', 'fixtures', 'hal-traps.json'), 'utf8'),
    ) as { claims: { trap: string; claim: string; first_pass_verdict: unknown; post_hal_verdict: unknown }[] };
    expect(fixture.claims).toHaveLength(10);
    const table = printT12TrapTable(fixture.claims);
    expect(table).toBe(
      [
        'trap\tfirst-pass\tpost-check',
        'surgeon\tpass\tcaught',
        'missing-dollar\tpass\tpass',
        'tuesday-boy\tpass\tcaught',
        'monty\tpass\tpass',
        'average-speed\tpass\tcaught',
        'disease\tpass\tpass',
        'ropes\tpass\tcaught',
        'two-envelope\tpass\tpass',
        'birthday\tpass\tpass',
        'ravens\tpass\tpass',
        '',
      ].join('\n'),
    );
    expect(table).not.toContain('\t0');
    expect(table).not.toContain('user_id');
    for (const claim of fixture.claims) expect(table).not.toContain(claim.claim);
    const miss = printT12TrapTable([{ trap: 'miss', first_pass_verdict: 0, post_hal_verdict: '0' }]);
    expect(miss).toBe('trap\tfirst-pass\tpost-check\nmiss\tNOT_CHECKED\tNOT_CHECKED\n');
    expect(miss).not.toContain('\t0');
  });

  it('does not raise a score for a self-only row', () => {
    const start = 10;
    const next = scoreAfterStampRow(start, { rater_id: 'same', subject_id: 'same', delta: 4 });
    expect(next).toBe(start);
    expect(next).not.toBe(start + 4);
    expect(next).not.toBe(0);
    const missing = scoreAfterStampRow(Number.NaN, { rater_id: 'same', subject_id: 'same', delta: 4 });
    expect(missing).toBe('NOT_CHECKED');
    expect(missing).not.toBe(0);
  });
});
