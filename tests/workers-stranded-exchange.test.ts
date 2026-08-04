/**
 * The stranded-exchange classifier.
 *
 * This exists because of a worker I nearly built. 148 contracts sit at `fulfilled`,
 * `escrowed → fulfilled` has a drain and `fulfilled → settled` does not, so "write the
 * missing drain" looks obvious.
 *
 * One query killed it: of 148, **zero** have a buyer verdict that failed to settle.
 * Every one is waiting on a buyer who never came — so a drain would not recover stuck
 * payments, it would pay providers for work nobody verified. That is the precise
 * inverse of the product's only real promise.
 *
 * The tests below pin the classification, and above all that `safeToAutoSettle` is
 * false everywhere except the one case that genuinely is.
 */

import {
  classifyExchange,
  formatSummary,
  summarise,
  type ExchangeRow,
} from '../src/workers/stranded-exchange-report';

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const row = (over: Partial<ExchangeRow> = {}): ExchangeRow => ({
  id: 'c1',
  status: 'fulfilled',
  fulfilled_at: daysAgo(70),
  settled_at: null,
  buyer_satisfaction_score: null,
  buyer_agent_id: 'buyer',
  provider_agent_id: 'provider',
  ...over,
});

describe('THE CASE THAT KILLED THE DRAIN WORKER', () => {
  it('delivered with no buyer verdict is AWAITING_BUYER and NOT auto-settleable', () => {
    const a = classifyExchange(row(), NOW);
    expect(a.state).toBe('AWAITING_BUYER');
    expect(a.safeToAutoSettle).toBe(false);
    expect(a.actionableBy).toBe('buyer');
  });

  it('the reason names the harm, so nobody re-derives the wrong fix', () => {
    expect(classifyExchange(row(), NOW).reason).toMatch(/nobody verified|never happens/);
  });

  it('a 77-day-old contract is STILL not auto-settleable — age is not consent', () => {
    // The tempting heuristic: "it has been 77 days, just settle it." Age says nothing
    // about whether the buyer approved the work.
    const a = classifyExchange(row({ fulfilled_at: daysAgo(77) }), NOW);
    expect(a.ageDays).toBe(77);
    expect(a.safeToAutoSettle).toBe(false);
  });

  it('a zero satisfaction score is a REJECTION, not a missing response', () => {
    // 0 is a real verdict. Treating it as "no answer yet" would let a rejected
    // deliverable drift back into the settle queue.
    const a = classifyExchange(row({ buyer_satisfaction_score: 0 }), NOW);
    expect(a.state).toBe('TERMINAL');
    expect(a.safeToAutoSettle).toBe(false);
  });
});

describe('the one legitimate retry case', () => {
  it('buyer approved but settlement did not complete IS auto-settleable', () => {
    const a = classifyExchange(row({ buyer_satisfaction_score: 5 }), NOW);
    expect(a.state).toBe('STRANDED_UNSETTLED');
    expect(a.safeToAutoSettle).toBe(true);
    expect(a.actionableBy).toBe('operator');
  });

  it('it is the ONLY state that is ever auto-settleable', () => {
    const states = [
      row(),
      row({ buyer_satisfaction_score: 0 }),
      row({ settled_at: daysAgo(20) }),
      row({ status: 'settled' }),
      row({ status: 'escrowed' }),
      row({ status: 'disputed' }),
    ].map((r) => classifyExchange(r, NOW));
    expect(states.filter((s) => s.safeToAutoSettle)).toHaveLength(0);
  });
});

describe('the back-dated reporting trap', () => {
  it('fulfilled + settled_at is LEGACY_BACKDATED, checked BEFORE awaiting-buyer', () => {
    // Those 24 rows are also awaiting a buyer. Folding them in is exactly what makes
    // the `settled_at IS NOT NULL` overcount invisible.
    const a = classifyExchange(row({ settled_at: daysAgo(26) }), NOW);
    expect(a.state).toBe('LEGACY_BACKDATED');
    expect(a.safeToAutoSettle).toBe(false);
    expect(a.reason).toMatch(/overcounts/);
  });

  it('a genuinely settled contract is TERMINAL, not back-dated', () => {
    expect(classifyExchange(row({ status: 'settled', settled_at: daysAgo(1) }), NOW).state).toBe('TERMINAL');
  });
});

describe('other statuses', () => {
  it.each([
    ['settled', 'TERMINAL'],
    ['resolved', 'TERMINAL'],
    ['cancelled', 'TERMINAL'],
    ['escrowed', 'IN_FLIGHT'],
    ['pending', 'IN_FLIGHT'],
    ['disputed', 'IN_FLIGHT'],
  ])('%s -> %s', (status, want) => {
    expect(classifyExchange(row({ status }), NOW).state).toBe(want);
  });
});

describe('bad input', () => {
  it('a missing fulfilled_at gives a null age rather than NaN', () => {
    expect(classifyExchange(row({ fulfilled_at: null }), NOW).ageDays).toBeNull();
  });

  it('an unparseable timestamp gives null, not a wild number', () => {
    expect(classifyExchange(row({ fulfilled_at: 'whenever' }), NOW).ageDays).toBeNull();
  });

  it('undefined satisfaction is treated the same as null — no response', () => {
    const r = { ...row(), buyer_satisfaction_score: undefined as unknown as null };
    expect(classifyExchange(r, NOW).state).toBe('AWAITING_BUYER');
  });
});

describe('the summary states the finding, not just counts', () => {
  const live = [
    ...Array.from({ length: 124 }, (_, i) => row({ id: `a${i}`, fulfilled_at: daysAgo(70) })),
    ...Array.from({ length: 24 }, (_, i) => row({ id: `b${i}`, settled_at: daysAgo(26) })),
    ...Array.from({ length: 7 }, (_, i) => row({ id: `s${i}`, status: 'settled' })),
  ];

  it('reproduces the live shape: 148 fulfilled, 0 auto-settleable', () => {
    const s = summarise(live, NOW);
    expect(s.byState.AWAITING_BUYER).toBe(124);
    expect(s.byState.LEGACY_BACKDATED).toBe(24);
    expect(s.byState.AWAITING_BUYER + s.byState.LEGACY_BACKDATED).toBe(148);
    expect(s.autoSettleable).toBe(0);
  });

  it('THE HEADLINE says a drain is the wrong fix, in words', () => {
    const s = summarise(live, NOW);
    expect(s.headline).toMatch(/waiting on a BUYER/);
    expect(s.headline).toMatch(/pay for unverified work/);
  });

  it('switches to the retry headline when a real stranded case appears', () => {
    const s = summarise([...live, row({ id: 'x', buyer_satisfaction_score: 4 })], NOW);
    expect(s.autoSettleable).toBe(1);
    expect(s.headline).toMatch(/legitimate retry/);
  });

  it('reports the oldest awaiting-buyer age, since that is the operator signal', () => {
    expect(summarise([row({ fulfilled_at: daysAgo(77) }), row()], NOW).oldestAwaitingBuyerDays).toBe(77);
  });

  it('an empty set is not an alarm', () => {
    expect(summarise([], NOW).headline).toBe('No stalled exchanges.');
  });

  it('the rendered summary flags the back-dated class inline', () => {
    expect(formatSummary(summarise(live, NOW))).toMatch(/NOT settled/);
  });
});

describe('THE STRUCTURAL GUARANTEE: this module cannot settle anything', () => {
  it('has no write, no settle import, and no flag that would enable one', () => {
    // Not "is currently off" — incapable. A future drain must be added deliberately,
    // by someone who has read the header explaining why the obvious one is wrong.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'workers', 'stranded-exchange-report.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
    expect(src).not.toMatch(/from ['"].*contract-settlement-finalize/);
    expect(src).not.toMatch(/from ['"].*x402/);
    expect(src).not.toMatch(/from ['"]\.\.\/db['"]/);
  });
});
