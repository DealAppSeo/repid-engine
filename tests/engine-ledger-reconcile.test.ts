/**
 * engine/ledger-reconcile.ts — the row must not be able to deny a movement it caused.
 *
 * The shape under test, stated once: `delta: 0` (or suppression metadata saying the
 * penalty was withheld) on a row whose score went down. 25,418 rows in prod carry a
 * version of it. The engine path can produce it because decay and the clamp move the
 * score without appearing in `delta`.
 *
 * These are pure-function tests. No DB, no env dependency except where a case
 * deliberately sets the flag and restores it.
 */

import {
  assessLedger,
  ledgerColumns,
  ledgerMetadata,
  parseLedgerMode,
  ledgerMode,
  logLedger,
  __resetLedgerLogLatch,
  LedgerMode,
} from '../src/engine/ledger-reconcile';

describe('parseLedgerMode', () => {
  it('defaults to off for absent, blank and unrecognised values', () => {
    for (const raw of [undefined, null, '', '   ', 'on', 'true', '1', 'ENFORCED', 'yes']) {
      expect(parseLedgerMode(raw as string | undefined | null)).toBe('off');
    }
  });

  it('accepts only the two explicit escalations, case- and space-insensitively', () => {
    expect(parseLedgerMode('shadow')).toBe('shadow');
    expect(parseLedgerMode('  SHADOW ')).toBe('shadow');
    expect(parseLedgerMode('enforce')).toBe('enforce');
    expect(parseLedgerMode(' Enforce')).toBe('enforce');
  });

  it('resolves from ENGINE_LEDGER_RECONCILE_MODE, defaulting to off', () => {
    const prev = process.env.ENGINE_LEDGER_RECONCILE_MODE;
    try {
      delete process.env.ENGINE_LEDGER_RECONCILE_MODE;
      expect(ledgerMode()).toBe('off');
      process.env.ENGINE_LEDGER_RECONCILE_MODE = 'enforce';
      expect(ledgerMode()).toBe('enforce');
    } finally {
      if (prev === undefined) delete process.env.ENGINE_LEDGER_RECONCILE_MODE;
      else process.env.ENGINE_LEDGER_RECONCILE_MODE = prev;
    }
  });
});

describe('assessLedger — the decomposition identity', () => {
  const cases: Array<{ name: string; before: number; decayedTo: number; delta: number; after: number }> = [
    { name: 'no decay, no clamp', before: 1000, decayedTo: 1000, delta: 20, after: 1020 },
    { name: 'decay only', before: 1000, decayedTo: 984, delta: 0, after: 984 },
    { name: 'decay and delta', before: 1000, decayedTo: 984, delta: 25, after: 1009 },
    { name: 'clamped at the ceiling', before: 10000, decayedTo: 10000, delta: 5, after: 10000 },
    { name: 'clamped at the floor', before: 12, decayedTo: 12, delta: -60, after: 10 },
  ];

  it.each(cases)('decay + delta + clamp equals the movement ($name)', (c) => {
    const a = assessLedger({ ...c, scoreMutated: true, mode: 'shadow' });
    expect(a.decay_points + a.delta_points + a.clamp_points).toBe(a.total_applied);
    expect(a.total_applied).toBe(c.after - c.before);
  });
});

describe('assessLedger — the contradiction this module exists to catch', () => {
  it('flags a withheld penalty (delta 0) whose score still dropped', () => {
    // An unproven STAKE / enforce-zeroed self-report / unconfirmed deception advisory:
    // the delta was correctly withheld, and decay moved the score anyway.
    const a = assessLedger({
      before: 1000, decayedTo: 984, delta: 0, after: 984, scoreMutated: true, mode: 'off',
    });
    expect(a.delta_points).toBe(0);
    expect(a.decay_points).toBe(-16);
    expect(a.total_applied).toBe(-16);
    expect(a.reconciles).toBe(false);
    expect(a.contradiction).toBe(true);
  });

  it('does not flag an honest row where the delta is the whole movement', () => {
    const a = assessLedger({
      before: 1000, decayedTo: 1000, delta: -8, after: 992, scoreMutated: true, mode: 'off',
    });
    expect(a.reconciles).toBe(true);
    expect(a.contradiction).toBe(false);
  });

  it('reports a clamp-shortened delta as non-reconciling but NOT as the contradiction', () => {
    // The row declares +5 and moved 0. Misleading, but it does not read as
    // "nothing happened" — contradiction is reserved for the delta-0 case.
    const a = assessLedger({
      before: 10000, decayedTo: 10000, delta: 5, after: 10000, scoreMutated: true, mode: 'off',
    });
    expect(a.clamp_points).toBe(-5);
    expect(a.total_applied).toBe(0);
    expect(a.reconciles).toBe(false);
    expect(a.contradiction).toBe(false);
  });

  it('treats a truly inert path as moving nothing, not as decaying', () => {
    // Shadow-deception: delta forced to 0 and the agent row is never written. The
    // counterfactual decay must NOT be reported as applied.
    const a = assessLedger({
      before: 1000, decayedTo: 1000, delta: 0, after: 1000, scoreMutated: false, mode: 'shadow',
    });
    expect(a.total_applied).toBe(0);
    expect(a.after).toBe(a.before);
    expect(a.decay_points).toBe(0);
    expect(a.reconciles).toBe(true);
    expect(a.contradiction).toBe(false);
  });

  it('models the trigger-applies case (WRITER_DIRECT_APPLY off) as movement === delta', () => {
    // The DB trigger applies COALESCE(repid_delta_calculated, delta, 0) — no decay,
    // no clamp — so the row reconciles by construction.
    const a = assessLedger({
      before: 1000, decayedTo: 984, delta: -8, after: 976, scoreMutated: false, mode: 'shadow',
    });
    expect(a.total_applied).toBe(-8);
    expect(a.after).toBe(992);
    expect(a.decay_points).toBe(0);
    expect(a.reconciles).toBe(true);
    expect(a.contradiction).toBe(false);
  });
});

describe('mode gating — off must leave the row byte-identical', () => {
  const contradicting = {
    before: 1000, decayedTo: 984, delta: 0, after: 984, scoreMutated: true,
  };

  it('off writes neither a column nor a metadata key', () => {
    const a = assessLedger({ ...contradicting, mode: 'off' });
    expect(ledgerColumns(a)).toEqual({});
    expect(ledgerMetadata(a)).toEqual({});
  });

  it('shadow writes metadata only — never the column', () => {
    const a = assessLedger({ ...contradicting, mode: 'shadow' });
    expect(ledgerColumns(a)).toEqual({});
    const meta = ledgerMetadata(a) as any;
    expect(meta.ledger_reconcile.mode).toBe('shadow');
    expect(meta.ledger_reconcile.contradiction).toBe(true);
    expect(meta.ledger_reconcile.total_applied).toBe(-16);
    // Sizes the flip without performing it.
    expect(meta.ledger_reconcile.would_write_repid_delta_applied).toBe(-16);
  });

  it('enforce writes repid_delta_applied equal to the real movement', () => {
    const a = assessLedger({ ...contradicting, mode: 'enforce' });
    expect(ledgerColumns(a)).toEqual({ repid_delta_applied: -16 });
    // The invariant the repo states a row owes: after - before === repid_delta_applied.
    expect(a.after - a.before).toBe((ledgerColumns(a) as any).repid_delta_applied);
  });

  it('enforce refuses to set the column when the app did not apply — no-applier hole', () => {
    // Setting repid_delta_applied makes the DB trigger back off. If the app also did
    // not write repid_agents, enforcing would leave nobody applying the delta.
    const a = assessLedger({
      before: 1000, decayedTo: 1000, delta: -8, after: 992, scoreMutated: false, mode: 'enforce',
    });
    expect(ledgerColumns(a)).toEqual({});
  });
});

describe('detection is not behind the flag', () => {
  const spies: jest.SpyInstance[] = [];
  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    spies.length = 0;
  });

  it.each<LedgerMode>(['off', 'shadow', 'enforce'])(
    'logs the contradiction loudly in mode %s',
    (mode) => {
      __resetLedgerLogLatch();
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      spies.push(err, log);

      const a = assessLedger({
        before: 1000, decayedTo: 984, delta: 0, after: 984, scoreMutated: true, mode,
      });
      logLedger(a, { agentId: 'agent-under-test', eventType: 'STAKE' });

      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]?.[0])).toContain('LEDGER CONTRADICTION');
    }
  );

  it('says nothing on a reconciling row beyond the one-time mode banner', () => {
    __resetLedgerLogLatch();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    spies.push(err, warn, log);

    const a = assessLedger({
      before: 1000, decayedTo: 1000, delta: 20, after: 1020, scoreMutated: true, mode: 'off',
    });
    logLedger(a, { agentId: 'agent-under-test', eventType: 'REFERRAL' });

    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1); // the resolved-mode banner, once
  });
});
