import { aggregateHonestyA } from '../src/services/honesty-a';

describe('honesty A form-feed family and host', () => {
  it('buckets FF-only family and host under NOT_CHECKED and stays counted', () => {
    const report = aggregateHonestyA([
      { family: '\f', host: '\f', verdict: 'TRUE' },
      { family: '\f\f', host: '\f', verdict: 'FALSE' },
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
    expect(report.first_pass).not.toBe(0);
    expect(JSON.stringify(report)).not.toContain('"first_pass":0');
  });

  it('does not create a real family or host bucket for FF-only input', () => {
    const report = aggregateHonestyA([
      { family: '\f', host: 'groq', verdict: 'TRUE' },
      { family: 'llama', host: '\f', verdict: 'FALSE' },
    ]);

    expect(report.status).toBe('counted');
    const keys = report.rows?.map((r) => `${r.family}|${r.host}`).sort();
    expect(keys).toEqual(['NOT_CHECKED|groq', 'llama|NOT_CHECKED']);
  });

  it('report JSON never contains user_id or claim prose', () => {
    const report = aggregateHonestyA([
      { family: '\f', host: '\f', verdict: 'TRUE' },
    ]);
    const json = JSON.stringify(report);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('claim');
  });
});
