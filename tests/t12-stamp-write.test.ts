import { readT12Stamp, writeT12Stamp } from '../src/orchestration/t12-stamp-write';

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
});
