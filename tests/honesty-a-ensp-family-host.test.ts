import { aggregateHonestyA } from '../src/services/honesty-a';

describe('Honesty A ENSP-only family/host bucketing', () => {
  it('treats an ENSP-only family as blank and lands under NOT_CHECKED', () => {
    const report = aggregateHonestyA([
      { family: '\u2002', host: 'groq', verdict: 'TRUE' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toHaveLength(1);
    expect(report.rows?.[0]).toEqual({
      family: 'NOT_CHECKED',
      host: 'groq',
      TRUE: 1,
      FALSE: 0,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
    });
  });

  it('treats an ENSP-only host as blank and lands under NOT_CHECKED', () => {
    const report = aggregateHonestyA([
      { family: 'llama', host: '\u2002', verdict: 'FALSE' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toHaveLength(1);
    expect(report.rows?.[0]).toEqual({
      family: 'llama',
      host: 'NOT_CHECKED',
      TRUE: 0,
      FALSE: 1,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
    });
  });

  it('treats an ENSP-only provider as blank and lands under NOT_CHECKED', () => {
    const report = aggregateHonestyA([
      { family: 'llama', provider: '\u2002', host: '\u2002', verdict: 'TRUE' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toHaveLength(1);
    expect(report.rows?.[0]).toEqual({
      family: 'llama',
      host: 'NOT_CHECKED',
      TRUE: 1,
      FALSE: 0,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
    });
  });

  it('multiple ENSP-only rows collapse to one NOT_CHECKED bucket, not a real family/host bucket', () => {
    const report = aggregateHonestyA([
      { family: '\u2002', host: '\u2002', verdict: 'TRUE' },
      { family: '\u2002\u2002', host: '\u2002\u2002', verdict: 'FALSE' },
      { family: '\u2002', host: '\u2002', verdict: 'UNCERTAIN' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toHaveLength(1);
    expect(report.rows?.[0]).toEqual({
      family: 'NOT_CHECKED',
      host: 'NOT_CHECKED',
      TRUE: 1,
      FALSE: 1,
      NOT_CHECKED: 1,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 3 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 3 },
    });
  });

  it('does not raise when family or host is ENSP-only', () => {
    expect(() =>
      aggregateHonestyA([{ family: '\u2002', host: '\u2002', verdict: 'TRUE' }]),
    ).not.toThrow();
  });
});
