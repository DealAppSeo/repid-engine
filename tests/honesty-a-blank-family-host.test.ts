import { aggregateHonestyA, HonestyVote } from '../src/services/honesty-a';

describe('honesty A blank or missing family and host', () => {
  it('buckets empty or missing family and host into NOT_CHECKED and keeps status counted', () => {
    const votes: HonestyVote[] = [
      { family: '', host: '', verdict: 'TRUE' },
      { family: '', provider: 'groq', verdict: 'FALSE' },
      { family: 'llama', host: '', verdict: 'TRUE' },
      { host: 'fireworks', verdict: 'FALSE' },
      { family: '', host: '', verdict: 'UNCERTAIN' },
      { family: undefined, host: null, verdict: 'TRUE' },
    ];

    const report = aggregateHonestyA(votes);

    expect(report.status).toBe('counted');
    expect(report.rows).not.toBeNull();
    expect(report.rows).toHaveLength(4);

    const rowByKey = new Map(
      report.rows!.map((r) => [`${r.family}|${r.host}`, r]),
    );

    expect(rowByKey.get('NOT_CHECKED|NOT_CHECKED')).toEqual({
      family: 'NOT_CHECKED',
      host: 'NOT_CHECKED',
      TRUE: 2,
      FALSE: 0,
      NOT_CHECKED: 1,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 3 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 3 },
    });

    expect(rowByKey.get('NOT_CHECKED|groq')).toEqual({
      family: 'NOT_CHECKED',
      host: 'groq',
      TRUE: 0,
      FALSE: 1,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
    });

    expect(rowByKey.get('NOT_CHECKED|fireworks')).toEqual({
      family: 'NOT_CHECKED',
      host: 'fireworks',
      TRUE: 0,
      FALSE: 1,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
    });

    expect(rowByKey.get('llama|NOT_CHECKED')).toEqual({
      family: 'llama',
      host: 'NOT_CHECKED',
      TRUE: 1,
      FALSE: 0,
      NOT_CHECKED: 0,
      first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
    });

    const json = JSON.stringify(report);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('claim');
  });

  it('does not use the number 0 for a missing first_pass on the empty family/host path', () => {
    const report = aggregateHonestyA([
      { family: '', host: '', verdict: 'TRUE' },
      { family: undefined, host: null, verdict: 'FALSE' },
      { family: '', host: '', verdict: 'TRUE', first_pass_verdict: 'TRUE' },
    ]);

    expect(report.status).toBe('counted');
    const row = report.rows?.find(
      (r) => r.family === 'NOT_CHECKED' && r.host === 'NOT_CHECKED',
    );
    expect(row).toBeDefined();
    expect(row!.first_pass).toEqual({ TRUE: 1, FALSE: 0, NOT_CHECKED: 2 });
    expect(row!.post_hal).toEqual({ TRUE: 0, FALSE: 0, NOT_CHECKED: 3 });
    expect(row!.first_pass.NOT_CHECKED).not.toBe(0);
  });
});
