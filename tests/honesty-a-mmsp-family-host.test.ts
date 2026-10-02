import { aggregateHonestyA } from '../src/services/honesty-a';

describe('honesty A MEDIUM MATHEMATICAL SPACE family and host', () => {
  it('buckets MMSP-only family and host under NOT_CHECKED and stays counted', () => {
    const report = aggregateHonestyA([
      { family: '\u205F', host: '\u205F', verdict: 'TRUE' },
      { family: '\u205F\u205F', host: '\u205F', verdict: 'FALSE' },
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

  it('does not create a real family or host bucket for MMSP-only input', () => {
    const report = aggregateHonestyA([
      { family: '\u205F', host: 'groq', verdict: 'TRUE' },
      { family: 'llama', host: '\u205F', verdict: 'FALSE' },
    ]);

    expect(report.status).toBe('counted');
    const keys = report.rows?.map((r) => `${r.family}|${r.host}`).sort();
    expect(keys).toEqual(['NOT_CHECKED|groq', 'llama|NOT_CHECKED']);
  });

  it('does not raise when family or host is MMSP-only', () => {
    expect(() =>
      aggregateHonestyA([{ family: '\u205F', host: '\u205F', verdict: 'TRUE' }]),
    ).not.toThrow();
  });

  it('report JSON never contains user_id or claim prose', () => {
    const report = aggregateHonestyA([
      { family: '\u205F', host: '\u205F', verdict: 'TRUE' },
    ]);
    const json = JSON.stringify(report);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('claim');
  });
});
