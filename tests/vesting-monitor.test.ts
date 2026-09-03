/**
 * The stranded-vesting monitor: three outcomes, a stable page reason, and no writes.
 *
 * The finding it watches for — vested RepID never credited after its cliff — went
 * unnoticed for months because it is silent from every direction. So the monitor's own
 * failure modes matter more than usual: a read that fails must NOT report zero stranded,
 * because zero is indistinguishable from a clean run and would re-bury the thing.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const from = jest.fn();
jest.mock('../src/db', () => ({ db: { from: (...a: any[]) => from(...a) } }));

const pageOperator = jest.fn();
jest.mock('../src/services/operator-pager', () => ({
  pageOperator: (...a: any[]) => pageOperator(...a),
}));

import { checkStrandedVesting, lastVestingCheck, _resetVestingMonitor, VESTING_GRACE_MS } from '../src/services/vesting-monitor';

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const agoDays = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

/** supabase-js shape: .from(t).select(cols).gt(col, v) resolves to {data,error}. */
function rows(data: any[] | null, error: any = null) {
  from.mockReturnValue({ select: () => ({ gt: async () => ({ data, error }) }) });
}

beforeEach(() => {
  from.mockReset();
  pageOperator.mockReset();
  _resetVestingMonitor();
});

describe('a read that failed is not a clean result', () => {
  it('reports checked:false on a query error and does NOT page', () => {
    // Paging here would be worse than silence: an alert whose cause is "we could not
    // look" trains the reader to ignore the alert that means "money is stuck".
    rows(null, { message: 'connection refused' });
    return checkStrandedVesting(NOW).then((r) => {
      expect(r.checked).toBe(false);
      expect(r.error).toMatch(/connection refused/);
      expect(r.stranded).toBe(0);
      expect(pageOperator).not.toHaveBeenCalled();
    });
  });

  it('reports checked:false when the client throws', async () => {
    from.mockImplementation(() => { throw new Error('boom'); });
    const r = await checkStrandedVesting(NOW);
    expect(r.checked).toBe(false);
    expect(r.error).toMatch(/boom/);
  });

  it('lastVestingCheck is null before the first run — absent, not clean', () => {
    expect(lastVestingCheck()).toBeNull();
  });
});

describe('classification', () => {
  it('counts a balance past its cliff AND past the grace window as stranded', async () => {
    rows([
      { id: 'a', vested_repid: 500, vesting_cliff_ends_at: agoDays(100) },
      { id: 'b', vested_repid: 19, vesting_cliff_ends_at: agoDays(30) },
    ]);
    const r = await checkStrandedVesting(NOW);
    expect(r.checked).toBe(true);
    expect(r.stranded).toBe(2);
    expect(r.stranded_repid).toBe(519);
    expect(r.oldest_stranded_cliff).toBe(agoDays(100));
  });

  it('does NOT count a balance still inside the grace window', async () => {
    // Just past the cliff is not yet a finding — a release job could be minutes away.
    const justPast = new Date(NOW - (VESTING_GRACE_MS - 60_000)).toISOString();
    rows([{ id: 'a', vested_repid: 500, vesting_cliff_ends_at: justPast }]);
    const r = await checkStrandedVesting(NOW);
    expect(r.stranded).toBe(0);
    expect(pageOperator).not.toHaveBeenCalled();
  });

  it('does NOT count a balance whose cliff is still running', async () => {
    rows([{ id: 'a', vested_repid: 500, vesting_cliff_ends_at: inDays(10) }]);
    const r = await checkStrandedVesting(NOW);
    expect(r.vesting).toBe(1);
    expect(r.stranded).toBe(0);
  });

  it('counts an undated balance separately — it is neither clean nor stranded', async () => {
    rows([{ id: 'a', vested_repid: 500, vesting_cliff_ends_at: null }]);
    const r = await checkStrandedVesting(NOW);
    expect(r.undated).toBe(1);
    expect(r.stranded).toBe(0);
    expect(pageOperator).not.toHaveBeenCalled();
  });

  it('a genuinely clean estate reports checked:true with nothing stranded', async () => {
    rows([]);
    const r = await checkStrandedVesting(NOW);
    expect(r).toMatchObject({ checked: true, holders: 0, stranded: 0, stranded_repid: 0 });
    expect(pageOperator).not.toHaveBeenCalled();
  });
});

describe('paging', () => {
  it('pages once, with a STABLE reason and the counts in the detail', async () => {
    rows([{ id: 'a', vested_repid: 500, vesting_cliff_ends_at: agoDays(100) }]);
    await checkStrandedVesting(NOW);
    expect(pageOperator).toHaveBeenCalledTimes(1);
    const [source, reason, detail] = pageOperator.mock.calls[0] as [string, string, any];
    expect(source).toBe('degraded');
    // THE REASON MUST NOT CARRY A COUNT. The pager dedupes on `${source}:${reason}`; a
    // reason that moved with the number would defeat the cooldown and emit one alert
    // every cycle forever — the alert becoming the noise it exists to cut through.
    expect(reason).not.toMatch(/\d/);
    expect(detail.agents).toBe(1);
    expect(detail.repid).toBe(500);
  });

  it('the reason string is identical across runs with different amounts', async () => {
    rows([{ id: 'a', vested_repid: 500, vesting_cliff_ends_at: agoDays(100) }]);
    await checkStrandedVesting(NOW);
    _resetVestingMonitor();
    rows([
      { id: 'a', vested_repid: 500, vesting_cliff_ends_at: agoDays(100) },
      { id: 'b', vested_repid: 7, vesting_cliff_ends_at: agoDays(2) },
    ]);
    await checkStrandedVesting(NOW);
    expect(pageOperator.mock.calls).toHaveLength(2);
    expect((pageOperator.mock.calls[0] as any[])[1]).toBe((pageOperator.mock.calls[1] as any[])[1]);
  });

  it('the page says the fix is not this monitor\'s to apply', async () => {
    rows([{ id: 'a', vested_repid: 500, vesting_cliff_ends_at: agoDays(100) }]);
    await checkStrandedVesting(NOW);
    const detail = (pageOperator.mock.calls[0] as any[])[2];
    expect(String(detail.note).toLowerCase()).toMatch(/decision|read-only/);
  });
});

describe('it writes nothing to the agents table', () => {
  it('only ever reads — no update, insert or delete on repid_agents', async () => {
    const calls: string[] = [];
    from.mockImplementation((t: string) => {
      calls.push(t);
      return {
        select: () => ({ gt: async () => ({ data: [], error: null }) }),
        // Present so a write attempt would resolve rather than throw, and be caught below.
        update: () => { throw new Error('MONITOR ATTEMPTED A WRITE'); },
        insert: () => { throw new Error('MONITOR ATTEMPTED A WRITE'); },
        delete: () => { throw new Error('MONITOR ATTEMPTED A WRITE'); },
      };
    });
    const r = await checkStrandedVesting(NOW);
    expect(r.checked).toBe(true);
    expect(calls).toEqual(['repid_agents']);
  });

  it('the source file contains no write verb against the agents table', () => {
    // Belt and braces: the mock above proves the paths exercised here do not write.
    // This proves no path does, including ones a future edit adds.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'vesting-monitor.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\.update\(|\.insert\(|\.delete\(|\.upsert\(/);
  });
});
