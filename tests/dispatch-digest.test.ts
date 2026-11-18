import { DIGEST_LINE_MAX, renderDigest, type DigestInput } from '../src/orchestration/dispatch-digest';

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  coverage: { total: 6, active: 2, ready: 1, blocked: 1, finished: 2 },
  verified: { independentlyVerified: 1, finished: 2, notChecked: 1 },
  decisions: [],
  headroom: 'groq ok, cerebras cooling until 11:00Z',
  next: 'route ticket 42 to the free lane',
  ...over,
});

describe('phone digest', () => {
  it('is exactly five lines, in order', () => {
    const lines = renderDigest(input()).split('\n');
    expect(lines.map((l) => l.split(':')[0])).toEqual(['Coverage', 'Verified', 'Decision', 'Headroom', 'Next']);
    expect(lines[0]).toBe('Coverage: 2/6 finished, 2 active, 1 ready, 1 blocked');
    expect(lines[1]).toBe('Verified: 1/2 independently, 1 not checked');
    expect(lines[2]).toBe('Decision: none waiting');
  });

  it('stays five lines when a field holds newlines, and each line fits a phone', () => {
    const out = renderDigest(input({ decisions: ['paste\nthe migration'], next: 'x'.repeat(300), headroom: 'a\nb\nc' }));
    const lines = out.split('\n');
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(DIGEST_LINE_MAX);
    expect(lines[2]).toBe('Decision: paste the migration');
  });

  it('counts several decisions and shows the first', () => {
    expect(renderDigest(input({ decisions: ['a', 'b'] })).split('\n')[2]).toBe('Decision: 2 waiting; first: a');
  });

  it('says unknown rather than printing an empty line', () => {
    const lines = renderDigest(input({ headroom: '', next: '' })).split('\n');
    expect(lines[3]).toBe('Headroom: unknown');
    expect(lines[4]).toBe('Next: unknown');
  });
});
