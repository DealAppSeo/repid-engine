/**
 * confession-timing-policy.test.ts — the live-config path, which is where the
 * ordering is easiest to break and hardest to notice.
 *
 * `repid_config.min_value` / `max_value` are DECORATIVE [MEASURED 2026-08-21]:
 * that table carries no CHECK constraint and no trigger, so an `UPDATE` setting
 * `late_self_report_discount` to `1.0` is simply accepted. At `1.0` a late
 * disclosure costs exactly what detection costs — and an agent holding an
 * undisclosed failure then faces "pay P for certain" against "pay P only if
 * caught", so concealment becomes strictly dominant again. That is the failure
 * the confession channel exists to fix, reinstated by one config edit, with no
 * error and no alarm.
 *
 * The declared bounds are still worth writing down; they are just documentation
 * until something enforces them. Until then, this is what enforces them.
 */
import { resolveTimingPolicy, SELF_REPORT_DISCOUNT } from '../src/services/repid-confession';
import { LATE_SELF_REPORT_DISCOUNT, SELF_REPORT_WINDOW_HOURS } from '../src/services/confession-window';

const selectIn = jest.fn();

jest.mock('../src/db', () => ({
  db: { from: jest.fn(() => ({ select: jest.fn(() => ({ in: selectIn })) })) },
}));

function configReturns(rows: Array<{ key: string; value: string }> | null, error: unknown = null) {
  selectIn.mockResolvedValueOnce({ data: rows, error });
}

beforeEach(() => selectIn.mockReset());

describe('resolving the timing policy from live config', () => {
  it('takes configured values when they preserve the ordering', async () => {
    configReturns([
      { key: 'confession_window_hours', value: '48' },
      { key: 'late_self_report_discount', value: '0.6' },
    ]);
    const p = await resolveTimingPolicy();
    expect(p).toEqual({ windowHours: 48, lateDiscount: 0.6 });
  });

  it('REFUSES a late discount of 1.0, which would make concealment dominant again', async () => {
    configReturns([
      { key: 'confession_window_hours', value: '24' },
      { key: 'late_self_report_discount', value: '1.0' },
    ]);
    const p = await resolveTimingPolicy();
    expect(p.lateDiscount).toBe(LATE_SELF_REPORT_DISCOUNT);
    expect(p.refusedConfig).toMatch(/breaks the required ordering/);
  });

  it('refuses a late discount at or below the prompt rate — waiting must never pay', async () => {
    for (const value of [String(SELF_REPORT_DISCOUNT), '0.2', '0']) {
      configReturns([{ key: 'late_self_report_discount', value }]);
      const p = await resolveTimingPolicy();
      expect(p.lateDiscount).toBe(LATE_SELF_REPORT_DISCOUNT);
      expect(p.refusedConfig).toBeDefined();
    }
  });

  it('refuses a non-numeric or absurd value rather than coercing it', async () => {
    for (const value of ['', 'soon', 'NaN', '-1']) {
      configReturns([{ key: 'late_self_report_discount', value }]);
      const p = await resolveTimingPolicy();
      expect(p.lateDiscount).toBe(LATE_SELF_REPORT_DISCOUNT);
    }
  });

  it('reports what it refused, so a bad edit is visible rather than silently ignored', async () => {
    configReturns([{ key: 'late_self_report_discount', value: '1.0' }]);
    const p = await resolveTimingPolicy();
    expect(p.refusedConfig).toContain('1.0');
    expect(p.refusedConfig).toContain(String(LATE_SELF_REPORT_DISCOUNT));
  });

  it('says nothing about a refusal when the key is simply absent', async () => {
    // An unset key is not a bad edit. Reporting one would train readers to
    // ignore the field.
    configReturns([{ key: 'confession_window_hours', value: '12' }]);
    const p = await resolveTimingPolicy();
    expect(p.windowHours).toBe(12);
    expect(p.refusedConfig).toBeUndefined();
  });
});

describe('fail-safe', () => {
  it('falls back to the constants when the config read errors', async () => {
    configReturns(null, { message: 'unreachable' });
    const p = await resolveTimingPolicy();
    expect(p).toEqual({
      windowHours: SELF_REPORT_WINDOW_HOURS,
      lateDiscount: LATE_SELF_REPORT_DISCOUNT,
    });
  });

  it('falls back when the read throws — a tuning table must never take the path down', async () => {
    selectIn.mockRejectedValueOnce(new Error('boom'));
    const p = await resolveTimingPolicy();
    expect(p.windowHours).toBe(SELF_REPORT_WINDOW_HOURS);
    expect(p.lateDiscount).toBe(LATE_SELF_REPORT_DISCOUNT);
  });

  it('rejects a non-positive window instead of collapsing it to "everything is late"', async () => {
    // windowHours = 0 would mark every disclosure LATE, quietly deleting the
    // prompt rate for everyone.
    configReturns([{ key: 'confession_window_hours', value: '0' }]);
    const p = await resolveTimingPolicy();
    expect(p.windowHours).toBe(SELF_REPORT_WINDOW_HOURS);
  });
});
