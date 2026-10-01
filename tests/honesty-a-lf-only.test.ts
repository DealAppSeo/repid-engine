import { aggregateHonestyA } from '../src/services/honesty-a';

describe('honesty A LF-only family/host', () => {
  it('treats LF-only family as NOT_CHECKED and does not create a real bucket', () => {
    const report = aggregateHonestyA([
      { family: '\n', host: 'groq', verdict: 'TRUE' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toEqual([
      {
        family: 'NOT_CHECKED',
        host: 'groq',
        TRUE: 1,
        FALSE: 0,
        NOT_CHECKED: 0,
        first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
        post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      },
    ]);
  });

  it('treats LF-only host as NOT_CHECKED and does not create a real bucket', () => {
    const report = aggregateHonestyA([
      { family: 'llama', host: '\n', verdict: 'FALSE' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toEqual([
      {
        family: 'llama',
        host: 'NOT_CHECKED',
        TRUE: 0,
        FALSE: 1,
        NOT_CHECKED: 0,
        first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
        post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      },
    ]);
  });

  it('treats multiple LFs as blank, not a named family or host', () => {
    const report = aggregateHonestyA([
      { family: '\n\n', host: 'groq', verdict: 'TRUE' },
      { family: 'llama', host: '\n\n\n', verdict: 'FALSE' },
    ]);
    expect(report.status).toBe('counted');
    const byKey = new Set(report.rows!.map((r) => `${r.family}:${r.host}`));
    expect(byKey.has('NOT_CHECKED:groq')).toBe(true);
    expect(byKey.has('llama:NOT_CHECKED')).toBe(true);
    expect(byKey.has('\n\n:groq')).toBe(false);
    expect(byKey.has('llama:\n\n\n')).toBe(false);
  });

  it('falls back to provider when host is LF-only, then to NOT_CHECKED if provider is also blank', () => {
    const withProvider = aggregateHonestyA([
      { family: 'llama', provider: 'groq', host: '\n', verdict: 'TRUE' },
    ]);
    expect(withProvider.rows?.[0]?.host).toBe('groq');

    const withBlankProvider = aggregateHonestyA([
      { family: 'llama', provider: '\n', host: '\n', verdict: 'TRUE' },
    ]);
    expect(withBlankProvider.rows?.[0]?.host).toBe('NOT_CHECKED');
  });

  it('does not raise for LF-only family or host', () => {
    expect(() =>
      aggregateHonestyA([
        { family: '\n', host: '\n', verdict: 'UNCERTAIN' },
        { family: '\n\n', provider: '\n', host: '\n', verdict: null },
      ]),
    ).not.toThrow();
  });
});
