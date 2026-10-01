import { aggregateHonestyA } from '../src/services/honesty-a';

describe('honesty A TAB-only family and host', () => {
  it('buckets TAB-only family and host under NOT_CHECKED and stays counted', () => {
    const report = aggregateHonestyA([
      { family: '\t', host: '\t', verdict: 'TRUE' },
      { family: '\t\t', host: '\t', verdict: 'FALSE' },
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

  it('report JSON never contains user_id or claim prose', () => {
    const report = aggregateHonestyA([
      { family: '\t', host: '\t', verdict: 'TRUE' },
    ]);
    const json = JSON.stringify(report);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('claim');
  });

  it('empty aggregate keeps first_pass as the string NOT_CHECKED, never the number 0', () => {
    const report = aggregateHonestyA([]);
    expect(report.status).toBe('counted');
    expect(report.rows).toEqual([]);
    expect(report.first_pass).toBe('NOT_CHECKED');
    expect(report.first_pass).not.toBe(0);
    expect(JSON.stringify(report)).not.toContain('"first_pass":0');
  });
});
