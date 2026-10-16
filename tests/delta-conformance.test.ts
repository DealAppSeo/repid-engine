/**
 * The delta-conformance checker must be able to say all three things — CONFORMS, DEVIATES and
 * NOT_CHECKED — and each DEVIATES case below is a defect the checker exists to catch. Row shapes
 * mirror what the live writers emit (metadata keys included); no production identifiers.
 */
import { checkRows, checkRow, DELTA_SPEC, type ScoreEventRow } from '../src/scoring/delta-conformance';
import { STARTING_REPID } from '../src/scoring/repid-constants';

let n = 0;
const row = (over: Partial<ScoreEventRow>): ScoreEventRow => {
  const delta = over.delta ?? 0;
  const before = over.repid_before ?? 1000;
  return {
    id: ++n, event_type: 'SERVICE_FULFILLED', delta, repid_before: before, repid_after: before + delta,
    repid_delta_calculated: delta, repid_delta_applied: delta, hal_decision: 'clean', hal_score: 0.5,
    hallucination_caught: false, is_shadow: false, metadata: {}, ...over,
  };
};
const statuses = (r: ScoreEventRow) => checkRow(r).map((v) => `${v.check}:${v.status}`);

describe('conforming live rows (the shapes seen in the ledger) produce no deviation', () => {
  const live = [
    row({ delta: 10, metadata: { role: 'provider' }, contract_id: 'c1', contract: { verdict: 'PASS' } }),
    row({ delta: 5, metadata: { role: 'buyer' }, contract_id: 'c1', contract: { verdict: 'PASS' } }),
    row({ event_type: 'SERVICE_SATISFIED', delta: 15, metadata: { role: 'provider', satisfaction_score: 0.5 } }),
    row({ event_type: 'SERVICE_SATISFIED', delta: 8, metadata: { role: 'buyer', satisfaction_score: 0.5 } }),
    row({ event_type: 'VALIDATION_FAILED', delta: -5, metadata: { role: 'producer', panel: [] } }),
    row({ event_type: 'VALIDATOR_REWARD', delta: 3, metadata: { role: 'verifier', panel: [], agreed_with_consensus: true } }),
    row({ event_type: 'VALIDATOR_PENALTY', delta: -5, metadata: { role: 'verifier', panel: [], agreed_with_consensus: false } }),
    row({ event_type: 'VALIDATION_FAILED', delta: -100, metadata: { role: 'provider', verdict: 'provider_at_fault' } }),
    row({ event_type: 'SERVICE_FULFILLED', delta: 20, metadata: { role: 'buyer', verdict: 'provider_at_fault' } }),
    row({ event_type: 'HAL_SCORE_EVENT', delta: -10, hal_decision: 'vetoed', hal_score: 0.5, hallucination_caught: true,
      metadata: { quorum_met: true, purpose: 'deliverable', purpose_suppressed: false } }),
    // purpose-suppressed veto: earned -10, applied 0 — conforms (the suppression is the spec).
    { ...row({ event_type: 'HAL_SCORE_EVENT', delta: 0, hal_decision: 'vetoed', hal_score: 0.5, hallucination_caught: true,
      metadata: { quorum_met: true, purpose_suppressed: true, suppressed_reason: 'wrong_task_purpose:peer_verify' } }), repid_delta_calculated: -10 },
    row({ event_type: 'GENESIS', delta: 0, repid_before: STARTING_REPID }),
  ];

  it('every row conforms', () => {
    const rep = checkRows(live);
    expect(rep.deviations).toEqual([]);
    expect(rep.not_checked).toBe(0);
    expect(rep.conforms).toBeGreaterThanOrEqual(live.length);
  });
});

describe('each defect class is caught (break the property, watch it go red)', () => {
  it('a satisfied delta paid flat instead of weighted by satisfaction', () => {
    expect(statuses(row({ event_type: 'SERVICE_SATISFIED', delta: 30, metadata: { role: 'provider', satisfaction_score: 0.5 } })))
      .toContain('A2A_SATISFIED:DEVIATES');
  });

  it('the settlement shadow trigger: buyer shadow paid flat, provider shadow claims a stale live rule', () => {
    const shadow = (role: string, delta: number, extra: object = {}) => ({
      ...row({ event_type: 'SERVICE_SATISFIED', delta, is_shadow: true, metadata: { role, mode: 'SHADOW_NO_MUTATION', buyer_satisfaction_score: 0.5, ...extra } }),
      repid_after: 1000, repid_delta_applied: 0,
    });
    expect(statuses(shadow('buyer', 15))).toEqual(['SHADOW_INERT:CONFORMS', 'SHADOW_SPEC:DEVIATES']);
    const provider = checkRow(shadow('provider', 15, { live_flat_delta_would_be: 30 }));
    expect(provider.map((v) => `${v.check}:${v.status}`)).toEqual(['SHADOW_INERT:CONFORMS', 'SHADOW_SPEC:CONFORMS', 'SHADOW_SPEC:DEVIATES']);
    expect(provider[2].reason).toMatch(/premise is stale/);
  });

  it('a shadow row that moved the score', () => {
    expect(statuses(row({ event_type: 'SERVICE_SATISFIED', delta: 8, is_shadow: true, metadata: { role: 'buyer', buyer_satisfaction_score: 0.5 } })))
      .toContain('SHADOW_INERT:DEVIATES');
  });

  it('a HAL penalty applied without the quorum gate', () => {
    expect(statuses(row({ event_type: 'HAL_SCORE_EVENT', delta: -10, hal_decision: 'vetoed', hallucination_caught: true, metadata: { quorum_met: false } })))
      .toContain('HAL:DEVIATES');
  });

  it('a HAL calculated delta that computeDelta does not produce', () => {
    expect(statuses(row({ event_type: 'HAL_SCORE_EVENT', delta: 3, hal_decision: 'clean', hal_score: 0.39 }))).toContain('HAL:DEVIATES');
  });

  it('RepID for an UNDETERMINED deliverable is named as the shipped keep policy, not hidden', () => {
    const v = checkRow(row({ delta: 10, metadata: { role: 'provider' }, contract_id: 'c2', contract: { verdict: 'UNDETERMINED' } }));
    const hit = v.find((x) => x.check === 'NO_REWARD_FOR_UNVERIFIED_WORK');
    expect(hit?.status).toBe('DEVIATES');
    expect(hit?.reason).toMatch(/keep/);
  });

  it('RepID on a VETO or a non-confident FAIL deliverable', () => {
    expect(statuses(row({ delta: 10, metadata: { role: 'provider' }, contract_id: 'c3', contract: { verdict: 'VETO' } })))
      .toContain('NO_REWARD_FOR_UNVERIFIED_WORK:DEVIATES');
    expect(statuses(row({ delta: 10, metadata: { role: 'provider' }, contract_id: 'c4', contract: { verdict: 'FAIL', confident: true } })))
      .not.toContain('NO_REWARD_FOR_UNVERIFIED_WORK:DEVIATES');
  });

  it('a ledger row that does not reconcile', () => {
    expect(statuses({ ...row({ delta: 10, metadata: { role: 'provider' } }), repid_after: 1020 })).toContain('LEDGER_RECONCILE:DEVIATES');
  });

  it('an event type nobody specified is an unexplained writer', () => {
    expect(statuses(row({ event_type: 'SOMETHING_NEW', delta: 7 }))).toContain('UNSPECIFIED:DEVIATES');
  });

  it('a dispute delta with the wrong sign', () => {
    expect(statuses(row({ event_type: 'VALIDATION_FAILED', delta: -50, metadata: { role: 'provider', verdict: 'provider_at_fault' } })))
      .toContain('A2A_DISPUTE:DEVIATES');
  });
});

describe('NOT_CHECKED is said out loud and never counted as conforming', () => {
  it('env-tuned and unattributable rows', () => {
    const rep = checkRows([
      row({ event_type: 'PREDICTION_RESOLVE', delta: 19 }),
      row({ event_type: 'CHALLENGE_WIN', delta: 40 }), // via /api/v1/score: env-tuned magnitude
      row({ delta: 119, metadata: {} }), // fulfilled row with no role (reconciliation era)
    ]);
    expect(rep.not_checked).toBe(3);
    expect(rep.not_checked_rows.every((r) => r.reason.length > 0)).toBe(true);
    // The only CONFORMS are the ledger reconciliations; the deltas themselves stay unchecked.
    expect(Object.keys(rep.by_check).filter((k) => rep.by_check[k].CONFORMS > 0)).toEqual(['LEDGER_RECONCILE']);
  });
});

describe('the spec table is rendered from code', () => {
  it('names a source for every check', () => {
    expect(DELTA_SPEC.length).toBeGreaterThan(10);
    expect(DELTA_SPEC.every((s) => s.source && s.rule && s.check)).toBe(true);
  });
});
