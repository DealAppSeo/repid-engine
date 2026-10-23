/**
 * RepID uncertainty (Glicko RD) — SHADOW. Five properties:
 *   1. The formulas are Glickman's: [G1]'s own worked examples reproduce (Step 2: RD 200 -> 151.4;
 *      Step 1b: c = 63.2 for RD 50 over 30 periods).
 *   2. Few checked outcomes = high RD; more = lower; never below the floor.
 *   3. Inactivity raises RD again, capped at the unrated 350.
 *   4. Excluded outcomes do not count: every #1461 threat fixture, self-trades, unknown owners,
 *      administrative-only distinctness, unsettled or simulated receipts, replays, future events.
 *   5. ISOLATION: nothing live can reach the module, it has no I/O, and it writes no RepID.
 * The clock is fixed (T0), so no result depends on the day the suite runs.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';

import {
  CHECKED_OUTCOME_GAME,
  C,
  PERIOD_MS,
  PERIODS_TO_UNRATED,
  RD_FLOOR,
  RD_UNRATED,
  cFor,
  eventFromSettledContract,
  expectedScore,
  g,
  isCheckedOutcome,
  rdAfterGames,
  rdAfterIdle,
  uncertaintyByAgent,
  type TimedEvent,
} from '../src/shadow/repid-uncertainty';
import { evaluateEligibility, evaluateEligibilityBatch, type EligibilityEvent } from '../src/shadow/antifarming-eligibility';
import { CASES, DISTINCT_ADMIN, DISTINCT_STRONG, SAME_ADMIN, SAME_STRONG, UNKNOWN } from './fixtures/antifarming-cases';
import { ROOT, discoverEntrypoints, reachable, referencesTo } from './helpers/import-graph';

const MODULE = join(ROOT, 'src', 'shadow', 'repid-uncertainty.ts');
const T0 = Date.UTC(2026, 0, 1);

/** A delivery #1461 credits: an engine-settled receipt bound to it, between strongly owner-distinct parties. */
const delivery = (actor: string, id: string, extra: Partial<EligibilityEvent> = {}): EligibilityEvent => ({
  event_id: id, kind: 'trade', actor_id: actor, counterparty_id: `buyer-${id}`, counterparty_owner: DISTINCT_STRONG,
  receipt: { receipt_id: `r-${id}`, server_settled: true, bound_event_id: id }, counterparty_reported_outcome: 'accepted',
  ...extra,
});
const at = (t: number, event: EligibilityEvent): TimedEvent => ({ at: t, event });
const deliveries = (k: number, actor = 'a', t = T0): TimedEvent[] =>
  Array.from({ length: k }, (_, i) => at(t, delivery(actor, `${actor}-${t}-${i}`)));
const rdOf = (events: TimedEvent[], asOf = T0, agent = 'a'): number => uncertaintyByAgent(events, asOf).get(agent)?.rd ?? RD_UNRATED;

describe('the method is Glickman\'s [G1], reproduced from the paper\'s own examples', () => {
  test('Step 2 example: g, E and RD\' for a 1500 player at RD 200 against (1400,30), (1550,100), (1700,300)', () => {
    const opponents = [[1400, 30], [1550, 100], [1700, 300]] as const;
    expect(opponents.map(([, rd]) => g(rd))).toEqual([expect.closeTo(0.9955, 4), expect.closeTo(0.9531, 4), expect.closeTo(0.7242, 4)]);
    expect(opponents.map(([r, rd]) => expectedScore(1500, r, rd))).toEqual([expect.closeTo(0.639, 3), expect.closeTo(0.432, 3), expect.closeTo(0.303, 3)]);
    const rd = rdAfterGames(200, opponents.map(([r, rd]) => ({ g: g(rd), e: expectedScore(1500, r, rd) })));
    expect(rd).toBeCloseTo(151.4, 1); // [G1]: sqrt(22918.9) = 151.4
  });

  test('Step 1b example: RD 50 back to 350 after 30 idle periods needs c = 63.2', () => {
    expect(cFor(50, 30)).toBeCloseTo(63.2, 1);
    expect(rdAfterIdle(50, 30, cFor(50, 30))).toBeCloseTo(350, 6);
    expect(rdAfterIdle(50, 31, cFor(50, 30))).toBe(350); // capped at the unrated RD
  });

  test('this file\'s c is the same method: an agent at the floor is unrated again after 12 idle periods', () => {
    expect(rdAfterIdle(RD_FLOOR, PERIODS_TO_UNRATED)).toBeCloseTo(RD_UNRATED, 6);
    expect(rdAfterIdle(RD_FLOOR, PERIODS_TO_UNRATED - 1)).toBeLessThan(RD_UNRATED);
    expect(C).toBeCloseTo(100.66, 2);
  });

  test('ADAPTED: a checked outcome is a game against a fully known reference at the agent\'s level (g = 1, E = 1/2)', () => {
    expect(CHECKED_OUTCOME_GAME).toEqual({ g: 1, e: 0.5 });
  });
});

describe('few checked outcomes = high uncertainty; more = lower', () => {
  test('no checked outcome is unrated: RD 350', () => {
    expect(uncertaintyByAgent([], T0).size).toBe(0);
    expect(rdOf([])).toBe(RD_UNRATED);
  });

  test('one checked outcome: still high (about 246.6)', () => {
    expect(rdOf(deliveries(1))).toBeCloseTo(246.6, 1);
  });

  test('every further checked outcome lowers RD, down to the floor and never below it', () => {
    const rds = [0, 1, 2, 5, 10, 25, 50, 100].map((k) => rdOf(deliveries(k)));
    for (let i = 1; i < rds.length; i++) expect(rds[i]).toBeLessThan(rds[i - 1] as number);
    expect(rdOf(deliveries(500))).toBe(RD_FLOOR);
  });

  test('a checked FAILURE informs as much as a pass ([G1]: outcomes always decrease RD)', () => {
    const pass = rdOf([at(T0, delivery('a', 'p', { confirmation: { by: 'known_answer', verdict: 'pass' } }))]);
    const fail = rdOf([at(T0, delivery('a', 'f', { confirmation: { by: 'known_answer', verdict: 'fail' } }))]);
    const rejected = rdOf([at(T0, delivery('a', 'r', { counterparty_reported_outcome: 'rejected' }))]);
    expect(pass).toBeLessThan(RD_UNRATED);
    expect(fail).toBe(pass);
    expect(rejected).toBe(pass);
  });
});

describe('inactivity raises uncertainty again [G1 Step 1b]', () => {
  const events = deliveries(20);

  test('RD rises every idle period and is capped at unrated after 12', () => {
    const rds = Array.from({ length: PERIODS_TO_UNRATED + 3 }, (_, k) => rdOf(events, T0 + k * PERIOD_MS));
    for (let k = 1; k <= PERIODS_TO_UNRATED; k++) expect(rds[k]).toBeGreaterThan(rds[k - 1] as number);
    expect(rds[PERIODS_TO_UNRATED]).toBe(RD_UNRATED);
    expect(rds[PERIODS_TO_UNRATED + 2]).toBe(RD_UNRATED);
  });

  test('the same 20 outcomes: recent leaves RD lower than a year old', () => {
    const asOf = T0 + 12 * PERIOD_MS;
    const recent = deliveries(20, 'a', asOf);
    expect(rdOf(recent, asOf)).toBeLessThan(rdOf(events, asOf));
  });

  test('steady activity keeps RD down; one idle period is not a reset', () => {
    const steady = Array.from({ length: 6 }, (_, p) => deliveries(10, 'a', T0 + p * PERIOD_MS)).flat();
    const asOf = T0 + 5 * PERIOD_MS;
    expect(rdOf(steady, asOf)).toBeLessThan(rdOf(deliveries(10, 'a', asOf), asOf));
    expect(rdOf(steady, asOf + PERIOD_MS)).toBeLessThan(RD_UNRATED);
  });
});

describe('excluded outcomes do not count', () => {
  const subject = (c: (typeof CASES)[number]) =>
    evaluateEligibilityBatch(c.events)[c.events.findIndex((e) => e.event_id === c.subject)]!;

  test.each(CASES.filter((c) => c.kind === 'threat').map((c) => [c.name, c] as const))('threat fixture %s adds no checked outcome', (_n, c) => {
    expect(isCheckedOutcome(subject(c))).toBe(false);
    const actor = c.events.find((e) => e.event_id === c.subject)!.actor_id;
    const u = uncertaintyByAgent(c.events.map((e) => at(T0, e)), T0).get(actor)!;
    // evidence_laundering's first event is the genuine trade its receipt was issued for; the two re-citations add nothing.
    const genuine = c.name === 'evidence_laundering' ? 1 : 0;
    expect(u.checked_outcomes).toBe(genuine);
    expect(u.not_counted).toBe(c.events.filter((e) => e.actor_id === actor).length - genuine);
    if (genuine === 0) expect(u.rd).toBe(RD_UNRATED);
  });

  test.each(CASES.filter((c) => c.kind === 'honest').map((c) => [c.name, c] as const))('honest fixture %s counts exactly when #1461 credits it', (_n, c) => {
    const r = subject(c);
    expect(isCheckedOutcome(r)).toBe(r.independent_credibility.status === 'COUNTS');
  });

  test('a small unknown newcomer is not counted: UNKNOWN is not evidence (and RD can only describe, never punish)', () => {
    const newcomer = CASES.find((c) => c.name === 'small_unknown_new_owner')!;
    expect(isCheckedOutcome(subject(newcomer))).toBe(false);
  });

  test('none of these moves RD: self-trades, unknown or administrative owners, no or unsettled receipts, laundering, easy self-picked tasks', () => {
    const base = deliveries(5);
    const excluded = [
      delivery('a', 'x1', { counterparty_owner: SAME_STRONG }),
      delivery('a', 'x2', { counterparty_owner: SAME_ADMIN }),
      delivery('a', 'x3', { counterparty_owner: UNKNOWN }),
      delivery('a', 'x4', { counterparty_owner: DISTINCT_ADMIN }),
      delivery('a', 'x5', { receipt: null }),
      delivery('a', 'x6', { receipt: { receipt_id: 'r-x6', server_settled: false, bound_event_id: 'x6' } }),
      delivery('a', 'x7', { receipt: { receipt_id: 'r-other', server_settled: true, bound_event_id: 'someone-else' } }),
      delivery('a', 'x8', { selection: { chosen_by: 'actor', baseline_pass_rate: 0.97 } }),
      delivery('a', 'x9', { funding: { payment_returned_to_payer_owner: true } }),
      delivery('a', 'x10', { counterparty_owner: DISTINCT_ADMIN, counterparty_reported_outcome: 'rejected' }),
    ].map((e) => at(T0, e));
    const before = uncertaintyByAgent(base, T0).get('a')!;
    const after = uncertaintyByAgent([...base, ...excluded], T0).get('a')!;
    expect(after.rd).toBe(before.rd);
    expect(after.checked_outcomes).toBe(5);
    expect(after.not_counted).toBe(excluded.length);
  });

  test('an agent whose only activity is excluded stays unrated', () => {
    const u = uncertaintyByAgent(Array.from({ length: 50 }, (_, i) => at(T0, delivery('wash', `w${i}`, { counterparty_owner: SAME_STRONG }))), T0).get('wash')!;
    expect(u).toMatchObject({ rd: RD_UNRATED, checked_outcomes: 0, not_counted: 50, last_checked_at: null });
  });

  test('a replayed event is one outcome, not two', () => {
    const one = deliveries(1);
    const replayed = [...one, ...one, at(T0 + 1, one[0]!.event)];
    expect(rdOf(replayed)).toBe(rdOf(one));
    expect(uncertaintyByAgent(replayed, T0 + 1).get('a')).toMatchObject({ checked_outcomes: 1, not_counted: 2 });
  });

  test('an outcome after asOf is not evidence yet', () => {
    expect(rdOf([...deliveries(3), ...deliveries(30, 'a', T0 + 1)], T0)).toBe(rdOf(deliveries(3)));
  });

  test('only the actor is credited, never the counterparty', () => {
    expect(uncertaintyByAgent(deliveries(3), T0).has('buyer-a-' + T0 + '-0')).toBe(false);
  });
});

describe('settled contracts as eligibility events (the live script\'s mapping)', () => {
  const row = { id: 'c1', provider_agent_id: 'prov', buyer_agent_id: 'buy' };
  type Settlement = { status: string | null; is_simulated: boolean | null };
  const REAL: Settlement = { status: 'settled', is_simulated: false };
  const counted = (owner: typeof DISTINCT_STRONG, settlements: Settlement[]) =>
    isCheckedOutcome(evaluateEligibility(eventFromSettledContract(row, owner, settlements)));

  test('one real settlement between strongly owner-distinct parties is a checked outcome for the PROVIDER', () => {
    expect(counted(DISTINCT_STRONG, [REAL])).toBe(true);
    expect(eventFromSettledContract(row, DISTINCT_STRONG, [REAL]).actor_id).toBe('prov');
  });

  test('simulated, missing, duplicated, not-settled or unknown settlements are not', () => {
    const cases: Settlement[][] = [
      [{ status: 'settled', is_simulated: true }], [], [REAL, REAL], [{ status: 'settled', is_simulated: null }],
      [{ status: 'pending', is_simulated: false }], [{ status: null, is_simulated: false }],
    ];
    for (const s of cases) expect([s, counted(DISTINCT_STRONG, s)]).toEqual([s, false]);
  });

  test('administrative-only distinctness (every settled trade in prod as of 2026-10-22) is not', () => {
    expect(counted(DISTINCT_ADMIN, [REAL])).toBe(false);
    expect(counted(SAME_ADMIN, [REAL])).toBe(false);
    expect(counted(UNKNOWN, [REAL])).toBe(false);
  });
});

describe('shadow: writes nothing, reaches nothing', () => {
  test('the record says shadow, writes no RepID, carries no score or delta, and is frozen', () => {
    const u = uncertaintyByAgent(deliveries(3), T0).get('a')!;
    expect(u.shadow).toBe(true);
    expect(u.writes_repid).toBe(false);
    expect(Object.keys(u).filter((k) => /delta|score|repid|tier/i.test(k))).toEqual(['writes_repid']);
    expect(Object.isFrozen(u)).toBe(true);
  });

  test('the module has no I/O, no environment, no clock: its one value import is the #1461 record', () => {
    const code = readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.match(/from\s+'([^']+)'/g)).toEqual(["from './antifarming-eligibility'"]);
    for (const banned of ['process.env', 'require(', 'import(', 'fetch(', 'console.', 'updateRepId', '.from(', 'Date.now', 'new Date', 'Math.random']) {
      expect([banned, code.includes(banned)]).toEqual([banned, false]);
    }
  });

  test('POSITIVE CONTROL: the walker reaches the live scorer from the API entrypoint', () => {
    const live = reachable(join(ROOT, 'src', 'index.ts'));
    expect(live.has(join(ROOT, 'src', 'engine', 'repid-update.ts'))).toBe(true);
    expect(live.size).toBeGreaterThan(50);
  });

  test('no live entrypoint can reach the module', () => {
    const entries = discoverEntrypoints();
    expect(entries.map((e) => relative(ROOT, e).replace(/\\/g, '/'))).toContain('src/index.ts');
    for (const e of entries) expect([relative(ROOT, e), reachable(e).has(MODULE)]).toEqual([relative(ROOT, e), false]);
  });

  test('nothing in src/ or scripts/ names it except itself and its printer; POSITIVE CONTROL: the scan sees its own import', () => {
    expect(referencesTo('repid-uncertainty', [join(ROOT, 'src'), join(ROOT, 'scripts')])).toEqual([
      'scripts/shadow/print-repid-uncertainty.ts',
      'src/shadow/repid-uncertainty.ts',
    ]);
    expect(referencesTo('antifarming-eligibility', [join(ROOT, 'src')])).toContain('src/shadow/repid-uncertainty.ts');
  });
});
