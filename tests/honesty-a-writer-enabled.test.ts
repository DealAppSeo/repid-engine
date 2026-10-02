/**
 * Honesty A writer_enabled gate — exact-string env check.
 *
 * Focused on the HAL_QUORUM_RECEIPT_ENABLED exact-string requirement.
 * Does not cover empty-vs-null, early-stop, or three-family open/merged themes.
 */

import {
  aggregateHonestyA,
  honestyANotChecked,
  HONESTY_A_LLM_LOG_GAP,
} from '../src/services/honesty-a';

describe('honesty A writer_enabled gate', () => {
  const writerEnvCases: Array<{
    label: string;
    value: string | undefined;
    expected: boolean;
  }> = [
    { label: 'unset', value: undefined, expected: false },
    { label: 'TRUE', value: 'TRUE', expected: false },
    { label: '1', value: '1', expected: false },
    { label: 'yes', value: 'yes', expected: false },
    { label: 'on', value: 'on', expected: false },
    { label: 'true', value: 'true', expected: true },
  ];

  it.each(writerEnvCases)(
    '$label → writer_enabled=$expected in both report paths',
    ({ value, expected }) => {
      const env =
        value === undefined ? {} : { HAL_QUORUM_RECEIPT_ENABLED: value };
      const counted = aggregateHonestyA([], env);
      const missed = honestyANotChecked(HONESTY_A_LLM_LOG_GAP, env);
      expect(counted.writer_enabled).toBe(expected);
      expect(missed.writer_enabled).toBe(expected);
    },
  );

  it('neither report path stores status or first_pass as numeric 0', () => {
    const counted = aggregateHonestyA([]);
    expect(counted.status).not.toBe(0);
    expect(counted.status).toBe('counted');
    expect(counted.first_pass).not.toBe(0);
    expect(counted.first_pass).toBe('NOT_CHECKED');

    const countedWithRow = aggregateHonestyA([
      { family: 'llama', provider: 'groq', verdict: 'TRUE' },
    ]);
    expect(countedWithRow.status).not.toBe(0);
    expect(countedWithRow.status).toBe('counted');
    expect(countedWithRow.rows?.[0]?.first_pass).not.toBe(0);
    expect(countedWithRow.rows?.[0]?.first_pass).toEqual({
      TRUE: 0,
      FALSE: 0,
      NOT_CHECKED: 1,
    });

    const missed = honestyANotChecked(HONESTY_A_LLM_LOG_GAP);
    expect(missed.status).not.toBe(0);
    expect(missed.status).toBe('NOT_CHECKED');
    expect(missed.first_pass).not.toBe(0);
    expect(missed.first_pass).toBeUndefined();
  });

  it('JSON of both reports never contains user_id or claim prose', () => {
    const counted = aggregateHonestyA([]);
    const countedWithRow = aggregateHonestyA([
      { family: 'llama', provider: 'groq', verdict: 'TRUE' },
    ]);
    const missed = honestyANotChecked(HONESTY_A_LLM_LOG_GAP);

    for (const report of [counted, countedWithRow, missed]) {
      const json = JSON.stringify(report);
      expect(json).not.toContain('user_id');
      expect(json).not.toContain('claim');
    }
  });
});
