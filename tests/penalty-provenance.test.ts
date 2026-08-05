/**
 * penalty-provenance.test.ts
 *
 * The load-bearing property: **dormancy must never be readable as dishonesty, and
 * misconduct must never be launderable as decay.** A dormant-but-honest agent and
 * a caught-fabricating agent can sit at the same RepID; `isBehavioral()` is the
 * only thing separating them, and an autonomy or HITL gate consults it.
 */

import {
  classifyPenalty,
  isBehavioral,
  summarizePenalties,
  describePenalties,
  type PenaltyEventRow,
} from '../src/repid/penalty-provenance';

const row = (o: Partial<PenaltyEventRow> = {}): PenaltyEventRow => ({ event_type: 'HAL_SCORE_EVENT', delta: -10, ...o });

describe('only losses are classified', () => {
  it('returns null for gains and zero — this module never characterises a gain', () => {
    for (const d of [1, 100, 0]) expect(classifyPenalty(row({ delta: d }))).toBeNull();
  });

  it('returns null for a non-numeric delta rather than guessing', () => {
    expect(classifyPenalty(row({ delta: 'oops' as any }))).toBeNull();
  });
});

describe('dormancy is not misconduct', () => {
  it('classifies decay as dormancy, not as a penalty class', () => {
    expect(classifyPenalty(row({ event_type: 'DORMANCY_DECAY', delta: -3 }))).toBe('dormancy_decay');
    expect(isBehavioral('dormancy_decay')).toBe(false);
  });

  // THE LAUNDERING ATTACK, BOTH WAYS.
  it('an incidental veto flag cannot inflate decay into misconduct', () => {
    const r = row({ event_type: 'DORMANCY_DECAY', delta: -3, hal_decision: 'vetoed', hallucination_caught: true });
    expect(classifyPenalty(r)).toBe('dormancy_decay');
  });

  it('misconduct cannot be relabelled as decay by its event_type alone', () => {
    // A real veto keeps its class even if the caller names the event something soft.
    const r = row({ event_type: 'ROUTINE_ADJUSTMENT', delta: -50, hallucination_caught: true });
    expect(classifyPenalty(r)).toBe('hallucination_veto');
    expect(isBehavioral('hallucination_veto')).toBe(true);
  });
});

describe('being wrong is not being dishonest', () => {
  it('a prediction miss is classified but NOT behavioral', () => {
    expect(classifyPenalty(row({ event_type: 'PREDICTION_RESOLVE', delta: -9 }))).toBe('prediction_miss');
    expect(isBehavioral('prediction_miss')).toBe(false);
  });

  it('but a prediction whose output was vetoed IS behavioral', () => {
    const r = row({ event_type: 'PREDICTION_RESOLVE', delta: -9, hal_decision: 'vetoed' });
    expect(classifyPenalty(r)).toBe('hallucination_veto');
  });
});

describe('evidence outranks the label', () => {
  it('recognises a HAL veto from either signal', () => {
    expect(classifyPenalty(row({ hal_decision: 'vetoed', hallucination_caught: false }))).toBe('hallucination_veto');
    expect(classifyPenalty(row({ hal_decision: 'clean', hallucination_caught: true }))).toBe('hallucination_veto');
  });

  it('separates a counterparty-attested failure from an unattested one', () => {
    // 21 of 26 VALIDATION_FAILED rows carry a contract_id; the rest have no
    // counterparty behind them and must not claim one.
    expect(classifyPenalty(row({ event_type: 'VALIDATION_FAILED', delta: -250, contract_id: 'c-1' })))
      .toBe('counterparty_dispute');
    expect(classifyPenalty(row({ event_type: 'VALIDATION_FAILED', delta: -250 })))
      .toBe('challenge_loss');
  });

  it('a blank contract_id is not a counterparty', () => {
    expect(classifyPenalty(row({ event_type: 'VALIDATION_FAILED', delta: -1, contract_id: '  ' })))
      .toBe('challenge_loss');
  });

  it('treats integrity breaches as their own most-serious class', () => {
    for (const t of ['EPISTEMIC_VIOLATION', 'VALIDATOR_PENALTY', 'COLLUSION', 'SLASH', 'DECEPTION']) {
      expect(classifyPenalty(row({ event_type: t, delta: -60 }))).toBe('integrity_violation');
      expect(isBehavioral('integrity_violation')).toBe(true);
    }
  });
});

describe('unrecognised shapes never brand an agent', () => {
  it('classifies unknown as unclassified and NOT behavioral', () => {
    // A gate that fails toward "guilty" on unknown input turns a scoring bug into
    // an accusation.
    expect(classifyPenalty(row({ event_type: 'SOMETHING_NEW', delta: -5 }))).toBe('unclassified');
    expect(isBehavioral('unclassified')).toBe(false);
  });

  it('administrative adjustments are not misconduct', () => {
    expect(classifyPenalty(row({ event_type: 'GENESIS', delta: -700 }))).toBe('administrative');
    expect(isBehavioral('administrative')).toBe(false);
  });
});

describe('summarizePenalties', () => {
  const LEDGER: PenaltyEventRow[] = [
    row({ event_type: 'HAL_SCORE_EVENT', delta: -10, hal_decision: 'vetoed' }),
    row({ event_type: 'HAL_SCORE_EVENT', delta: -10, hal_decision: 'vetoed' }),
    row({ event_type: 'VALIDATION_FAILED', delta: -250, contract_id: 'c-1' }),
    row({ event_type: 'DORMANCY_DECAY', delta: -30 }),
    row({ event_type: 'PREDICTION_RESOLVE', delta: -0 - 20 }),
    row({ event_type: 'SERVICE_SATISFIED', delta: +22 }), // gain — must be ignored
  ];

  it('ignores gains and counts only losses', () => {
    const b = summarizePenalties(LEDGER);
    expect(b.totalPenaltyEvents).toBe(5);
    expect(b.totalPenaltyDelta).toBe(-320);
  });

  it('separates behavioral loss from dormancy', () => {
    const b = summarizePenalties(LEDGER);
    expect(b.behavioral).toEqual({ events: 3, netDelta: -270 });
    expect(b.dormancy).toEqual({ events: 1, netDelta: -30 });
    // 270 of 320
    expect(b.behavioralShareOfLosses).toBeCloseTo(270 / 320, 5);
  });

  it('every classified loss lands in exactly one class', () => {
    const b = summarizePenalties(LEDGER);
    expect(Object.values(b.byClass).reduce((a, x) => a + x.events, 0)).toBe(b.totalPenaltyEvents);
  });

  it('a purely dormant agent reads 0% behavioral, not "unknown"', () => {
    // The whole point: quiet must be distinguishable from dishonest.
    const b = summarizePenalties([row({ event_type: 'DORMANCY_DECAY', delta: -50 })]);
    expect(b.behavioralShareOfLosses).toBe(0);
    expect(b.integrityEvents).toBe(0);
  });

  it('returns null share when there are no losses at all', () => {
    expect(summarizePenalties([]).behavioralShareOfLosses).toBeNull();
    expect(summarizePenalties([row({ delta: +5 })]).behavioralShareOfLosses).toBeNull();
  });

  it('surfaces integrity violations separately from other behavioral loss', () => {
    const b = summarizePenalties([row({ event_type: 'EPISTEMIC_VIOLATION', delta: -60 })]);
    expect(b.integrityEvents).toBe(1);
    expect(b.behavioral.events).toBe(1);
  });
});

describe('describePenalties', () => {
  it('names dormancy explicitly so quiet is never read as guilt', () => {
    const s = describePenalties(summarizePenalties([
      row({ event_type: 'DORMANCY_DECAY', delta: -30 }),
      row({ hal_decision: 'vetoed', delta: -10 }),
    ]));
    expect(s).toMatch(/dormancy -30/);
    expect(s).toMatch(/behavioural/);
  });

  it('says so plainly when there is nothing on record', () => {
    expect(describePenalties(summarizePenalties([]))).toBe('no penalties on record');
  });
});
