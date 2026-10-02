import { writeStamp } from '../src/orchestration/stamp-row';

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
