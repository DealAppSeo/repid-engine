import { aggregateHonestyA } from '../src/services/honesty-a';

describe('honesty A four-per-em family and host', () => {
  it('buckets four-per-em-only family and host under NOT_CHECKED and stays counted', () => {
    const report = aggregateHonestyA([
      { family: '\u2005', host: '\u2005', verdict: 'TRUE' },
      { family: '\u2005\u2005', host: '\u2005', verdict: 'FALSE' },
    ]);

    expect(report.status).toBe('counted');
    expect(report.rows).toHaveLength(1);
    const row = report.rows?.[0];
    expect(row).toEqual({
      family: 'NOT_CHECKED',
      host: 'NOT_CHECKED',
      TRUE: 1,
      FALSE: 1,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 2 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 2 },
    });
    expect(row?.first_pass.NOT_CHECKED).not.toBe(0);
  });

  it('does not create a real family or host bucket for four-per-em-only input', () => {
    const report = aggregateHonestyA([
      { family: '\u2005', host: 'groq', verdict: 'TRUE' },
      { family: 'llama', host: '\u2005', verdict: 'FALSE' },
    ]);

    expect(report.status).toBe('counted');
    const keys = report.rows?.map((r) => `${r.family}|${r.host}`).sort();
    expect(keys).toEqual(['NOT_CHECKED|groq', 'llama|NOT_CHECKED']);
  });

  it('does not raise when family or host is four-per-em-only', () => {
    expect(() =>
      aggregateHonestyA([{ family: '\u2005', host: '\u2005', verdict: 'TRUE' }]),
    ).not.toThrow();
  });

  it('report JSON never contains user_id or claim prose', () => {
    const report = aggregateHonestyA([
      { family: '\u2005', host: '\u2005', verdict: 'TRUE' },
    ]);
    const json = JSON.stringify(report);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('claim');
  });
});
