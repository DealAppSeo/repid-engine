import { aggregateHonestyA } from '../src/services/honesty-a';

describe('honesty A CR-only family/host', () => {
  it('treats a CR-only family as NOT_CHECKED instead of a real bucket', () => {
    const report = aggregateHonestyA([
      { family: '\r', provider: 'groq', verdict: 'TRUE' },
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

  it('treats a CR-only host as NOT_CHECKED instead of a real bucket', () => {
    const report = aggregateHonestyA([
      { family: 'llama', host: '\r', verdict: 'TRUE' },
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

  it('treats CR-only family and host together as one NOT_CHECKED bucket', () => {
    const report = aggregateHonestyA([
      { family: '\r', host: '\r', verdict: 'TRUE' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toHaveLength(1);
    expect(report.rows?.[0]).toEqual({
      family: 'NOT_CHECKED',
      host: 'NOT_CHECKED',
      TRUE: 1,
      FALSE: 0,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
    });
  });
});
