import {
  aggregateHonestyA,
  honestyANotChecked,
  HONESTY_A_LLM_LOG_GAP,
} from '../src/services/honesty-a';

describe('Honesty A empty rows vs null rows', () => {
  it('keeps a counted empty read distinct from a NOT_CHECKED read', () => {
    const empty = aggregateHonestyA([]);
    const failed = honestyANotChecked(HONESTY_A_LLM_LOG_GAP);

    expect(empty.status).toBe('counted');
    expect(Array.isArray(empty.rows)).toBe(true);
    expect(empty.rows).toEqual([]);

    expect(failed.status).toBe('NOT_CHECKED');
    expect(failed.rows).toBeNull();

    expect(empty.rows).not.toBe(failed.rows);
    expect(empty.rows).not.toBeNull();
    expect(failed.rows).not.toEqual([]);
  });

  it('never stores first_pass or status as the number 0', () => {
    const empty = aggregateHonestyA([]);
    expect(empty.status).not.toBe(0);
    expect(typeof empty.status).toBe('string');
    expect(empty.first_pass).not.toBe(0);
    expect(empty.first_pass).toBe('NOT_CHECKED');

    const failed = honestyANotChecked(HONESTY_A_LLM_LOG_GAP);
    expect(failed.status).not.toBe(0);
    expect(typeof failed.status).toBe('string');
    expect(failed.first_pass).not.toBe(0);
  });

  it('JSON of both reports never contains user_id or claim prose', () => {
    const empty = aggregateHonestyA([]);
    const failed = honestyANotChecked(HONESTY_A_LLM_LOG_GAP);
    const combined = JSON.stringify({ empty, failed }).toLowerCase();

    expect(combined).not.toContain('user_id');
    expect(combined).not.toContain('claim');
  });
});
