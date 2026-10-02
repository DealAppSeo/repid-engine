import { readFileSync } from 'node:fs';
import path from 'node:path';
import { printTrapTable, writeStamp } from '../src/orchestration/stamp-row';

describe('stamp writer', () => {
  it('writes caught for a veto', () => {
    const input = { verdict: 'veto', score: 3, claim: 'The surgeon is the boy mother.', user_id: 'u1' };
    const row = writeStamp(input);
    expect(row.stamp).toBe('caught');
    expect(writeStamp({ verdict: 'FALSE', score: 3 }).stamp).toBe('caught');
    expect(Object.keys(row).sort()).toEqual(['score', 'stamp']);
    expect(JSON.stringify(row)).not.toContain('user_id');
    expect(JSON.stringify(row)).not.toContain('surgeon');
  });

  it('writes pass for a pass', () => {
    const row = writeStamp({ verdict: 'pass', score: 2 });
    expect(row.stamp).toBe('pass');
    expect(writeStamp({ verdict: 'TRUE', score: 2 }).stamp).toBe('pass');
    expect(Object.keys(row).sort()).toEqual(['score', 'stamp']);
  });

  it('writes NOT_CHECKED for a timeout', () => {
    const row = writeStamp({ verdict: 'pass', timeout: true, score: 4 });
    expect(row.stamp).toBe('NOT_CHECKED');
    expect(row.stamp).not.toBe(0);
    expect(writeStamp({ verdict: 'timeout', score: 4 }).stamp).toBe('NOT_CHECKED');
  });

  it('writes NOT_CHECKED for a missing score, not 0', () => {
    expect(writeStamp({ verdict: 'pass' }).score).toBe('NOT_CHECKED');
    expect(writeStamp({ verdict: 'pass', score: undefined }).score).toBe('NOT_CHECKED');
    expect(writeStamp({ verdict: 'pass', score: null }).score).toBe('NOT_CHECKED');
    expect(writeStamp({ verdict: 'pass', score: '' }).score).toBe('NOT_CHECKED');
    expect(writeStamp({ verdict: 'veto', score: 0 }).score).toBe('NOT_CHECKED');
    expect(writeStamp({ verdict: 'veto', score: '0' }).score).toBe('NOT_CHECKED');
    expect(writeStamp({ verdict: 'pass', score: 0 }).score).not.toBe(0);
    expect(writeStamp({ verdict: 'pass', score: 2 }).score).toBe(2);
  });
});

describe('ten fixture claims', () => {
  it('prints first-pass and post-check, and a miss stays NOT_CHECKED', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'scripts', 'fixtures', 'hal-traps.json'), 'utf8'),
    ) as { claims: { trap: string; claim: string; first_pass_verdict: unknown; post_hal_verdict: unknown }[] };
    expect(fixture.claims).toHaveLength(10);
    const table = printTrapTable(fixture.claims);
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
    const miss = printTrapTable([{ trap: 'miss', first_pass_verdict: 0, post_hal_verdict: '0' }]);
    expect(miss).toBe('trap\tfirst-pass\tpost-check\nmiss\tNOT_CHECKED\tNOT_CHECKED\n');
    expect(miss).not.toContain('\t0');
  });
});
