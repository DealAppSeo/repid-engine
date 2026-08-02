/**
 * Self-healing for a delivered-but-unpaid contract.
 *
 * When /satisfy's release throws, the state machine hands the authorization back
 * to 'authorized' — correct, and no money moves — but NOTHING retries. The
 * contract sits `fulfilled`: work delivered and accepted, provider unpaid,
 * authorization still good. Observed live 2026-08-02 on contract
 * 2e89cea0-c540-4a19-8adc-47df56cf5be1, which only healed because a human
 * happened to retry by hand.
 *
 * The dangerous failure modes for a worker like this are (a) paying for work
 * nobody accepted, and (b) moving money and then failing to finish, which is
 * worse than the state it set out to repair. Both are pinned below.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import {
  runRetrySweep,
  isStranded,
  isDue,
  backoffFor,
  parseRetryMode,
  MAX_ATTEMPTS,
  type StrandedContract,
  type RetryDeps,
} from '../src/services/x402-release-retry-worker';

const NOW = 1_800_000_000_000;

function stranded(over: Partial<StrandedContract> = {}): StrandedContract {
  return {
    contractId: 'c-1',
    settlementId: 's-1',
    providerAgentId: 'prov-1',
    agreedPriceRaw: 100000,
    satisfactionScore: 1,
    attempts: 0,
    lastAttemptedAt: null,
    ...over,
  };
}

function deps(over: Partial<RetryDeps> = {}): RetryDeps & {
  released: string[];
  finalized: string[];
  escalations: Array<{ id: string; reason: string }>;
  attempts: Array<{ id: string; ok: boolean }>;
} {
  const released: string[] = [];
  const finalized: string[] = [];
  const escalations: Array<{ id: string; reason: string }> = [];
  const attempts: Array<{ id: string; ok: boolean }> = [];
  const base: RetryDeps = {
    findStranded: async () => [stranded()],
    release: async (s) => {
      released.push(s.contractId);
      return { status: 'SETTLED', txHash: '0xdead' };
    },
    finalize: async (s) => {
      finalized.push(s.contractId);
      return { ok: true };
    },
    recordAttempt: async (s, ok) => {
      attempts.push({ id: s.contractId, ok });
    },
    escalate: async (s, reason) => {
      escalations.push({ id: s.contractId, reason });
    },
    now: () => NOW,
  };
  return Object.assign(base, over, { released, finalized, escalations, attempts });
}

// ===========================================================================
describe('what counts as stranded — never invent an acceptance', () => {
  const base = {
    contract_status: 'fulfilled',
    settlement_status: 'authorized',
    verdict: 'PASS',
    buyer_satisfaction_score: 1,
  };

  it('is stranded when delivered, accepted, and still authorized', () => {
    expect(isStranded(base)).toBe(true);
  });

  it('is NOT stranded when the buyer never accepted — that is a normal wait', () => {
    expect(isStranded({ ...base, buyer_satisfaction_score: null })).toBe(false);
    expect(isStranded({ ...base, buyer_satisfaction_score: 0 })).toBe(false);
  });

  it('is NOT stranded when the deliverable did not pass', () => {
    expect(isStranded({ ...base, verdict: 'VETO' })).toBe(false);
    expect(isStranded({ ...base, verdict: null })).toBe(false);
  });

  it('is NOT stranded once the settlement already moved', () => {
    expect(isStranded({ ...base, settlement_status: 'settled' })).toBe(false);
    expect(isStranded({ ...base, settlement_status: 'voided' })).toBe(false);
    expect(isStranded({ ...base, settlement_status: 'settling' })).toBe(false);
  });

  it('is NOT stranded when the contract is not fulfilled', () => {
    expect(isStranded({ ...base, contract_status: 'escrowed' })).toBe(false);
    expect(isStranded({ ...base, contract_status: 'settled' })).toBe(false);
  });
});

// ===========================================================================
describe('backoff and attempt bounds', () => {
  it('escalates the delay and never retries instantly forever', () => {
    expect(backoffFor(0)).toBe(30_000);
    expect(backoffFor(2)).toBe(120_000);
    expect(backoffFor(4)).toBe(3_600_000);
    expect(backoffFor(99)).toBe(3_600_000);
  });

  it('a never-attempted contract is due immediately', () => {
    expect(isDue(stranded({ attempts: 0, lastAttemptedAt: null }), NOW)).toBe(true);
  });

  it('honours the backoff window', () => {
    const last = new Date(NOW - 10_000).toISOString();
    expect(isDue(stranded({ attempts: 1, lastAttemptedAt: last }), NOW)).toBe(false);
    const older = new Date(NOW - 40_000).toISOString();
    expect(isDue(stranded({ attempts: 1, lastAttemptedAt: older }), NOW)).toBe(true);
  });

  it('is never due once the attempt cap is reached', () => {
    expect(isDue(stranded({ attempts: MAX_ATTEMPTS, lastAttemptedAt: null }), NOW)).toBe(false);
  });
});

// ===========================================================================
describe('mode discipline', () => {
  it('defaults to off, and only exact words enable it', () => {
    expect(parseRetryMode(undefined)).toBe('off');
    expect(parseRetryMode('')).toBe('off');
    expect(parseRetryMode('true')).toBe('off');
    expect(parseRetryMode('1')).toBe('off');
    expect(parseRetryMode('shadow')).toBe('shadow');
    expect(parseRetryMode('enforce')).toBe('enforce');
  });

  it('off does nothing at all — it does not even look', async () => {
    const d = deps();
    const r = await runRetrySweep(d, 'off');
    expect(r.examined).toBe(0);
    expect(d.released).toHaveLength(0);
  });

  it('shadow reports what it would do and touches nothing', async () => {
    const d = deps();
    const r = await runRetrySweep(d, 'shadow');
    expect(r.eligible).toBe(1);
    expect(r.wouldAttempt).toEqual(['c-1']);
    expect(d.released).toHaveLength(0);
    expect(d.finalized).toHaveLength(0);
  });
});

// ===========================================================================
describe('enforce — the healing path', () => {
  it('releases then finalizes, and reports recovery', async () => {
    const d = deps();
    const r = await runRetrySweep(d, 'enforce');
    expect(d.released).toEqual(['c-1']);
    expect(d.finalized).toEqual(['c-1']);
    expect(r.recovered).toBe(1);
    expect(d.attempts).toEqual([{ id: 'c-1', ok: true }]);
  });

  it('finalizes on ALREADY_SETTLED — the money is there, the ledger must catch up', async () => {
    const d = deps({ release: async () => ({ status: 'ALREADY_SETTLED', txHash: '0xold' }) });
    const r = await runRetrySweep(d, 'enforce');
    expect(d.finalized).toEqual(['c-1']);
    expect(r.recovered).toBe(1);
  });

  it('does NOT finalize when the release failed — no money, no settlement', async () => {
    const d = deps({ release: async () => ({ status: 'FAILED', reason: 'facilitator 502' }) });
    const r = await runRetrySweep(d, 'enforce');
    expect(d.finalized).toHaveLength(0);
    expect(r.recovered).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(d.attempts).toEqual([{ id: 'c-1', ok: false }]);
  });

  it('refuses to touch a voided authorization', async () => {
    const d = deps({
      release: async () => ({ status: 'REFUSED', reason: 'this authorization was voided' }),
    });
    const r = await runRetrySweep(d, 'enforce');
    expect(d.finalized).toHaveLength(0);
    expect(r.recovered).toBe(0);
  });

  // The worst outcome available to this worker: money moved, ledger did not.
  it('PAID BUT NOT FINALIZED escalates and is never counted as recovered', async () => {
    const d = deps({ finalize: async () => ({ ok: false, error: 'db down' }) });
    const r = await runRetrySweep(d, 'enforce');
    expect(r.recovered).toBe(0);
    expect(d.escalations).toHaveLength(1);
    expect(d.escalations[0]!.reason).toMatch(/PAID BUT NOT FINALIZED/);
    expect(d.escalations[0]!.reason).toMatch(/0xdead/);
  });
});

// ===========================================================================
describe('giving up is a decision a human hears about', () => {
  it('escalates and stops once the cap is reached', async () => {
    const d = deps({ findStranded: async () => [stranded({ attempts: MAX_ATTEMPTS })] });
    const r = await runRetrySweep(d, 'enforce');
    expect(r.abandoned).toBe(1);
    expect(d.released).toHaveLength(0);
    expect(d.escalations[0]!.reason).toMatch(/abandoned after 5 attempts/);
  });

  it('escalates on the attempt that reaches the cap', async () => {
    const d = deps({
      findStranded: async () => [stranded({ attempts: MAX_ATTEMPTS - 1 })],
      release: async () => ({ status: 'FAILED', reason: 'facilitator still down' }),
    });
    const r = await runRetrySweep(d, 'enforce');
    expect(r.abandoned).toBe(1);
    expect(d.escalations[0]!.reason).toMatch(/final attempt failed/);
  });

  it('skips a contract still inside its backoff without consuming an attempt', async () => {
    const d = deps({
      findStranded: async () => [
        stranded({ attempts: 2, lastAttemptedAt: new Date(NOW - 1000).toISOString() }),
      ],
    });
    const r = await runRetrySweep(d, 'enforce');
    expect(r.eligible).toBe(0);
    expect(d.released).toHaveLength(0);
    expect(d.attempts).toHaveLength(0);
  });
});
