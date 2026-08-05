/**
 * ledger-provenance.test.ts
 *
 * The load-bearing property is that **event_type can never upgrade an event's
 * trust**. event_type is caller-supplied, so letting it vouch for itself is
 * circular — it is precisely the field an attacker controls. Most of these tests
 * are attacks on that boundary.
 */

import {
  classifyProvenance,
  summarizeProvenance,
  describeProvenance,
  isExternallyVerifiable,
  hasEvidenceRef,
  SELF_AWARDABLE_EVENT_TYPES,
  type ScoreEventRow,
} from '../src/repid/ledger-provenance';

const row = (o: Partial<ScoreEventRow> = {}): ScoreEventRow => ({ event_type: 'SERVICE_SATISFIED', delta: 10, ...o });

describe('classification is driven by evidence, not by the label', () => {
  it('classifies a contract-backed event as counterparty_verified', () => {
    expect(classifyProvenance(row({ contract_id: 'c-1' }))).toBe('counterparty_verified');
  });

  it('classifies an on-chain attestation as onchain_anchored', () => {
    expect(classifyProvenance(row({ eas_attestation_id: '0xabc' }))).toBe('onchain_anchored');
    expect(classifyProvenance(row({ zk_proof_id: 'zk-1' }))).toBe('onchain_anchored');
  });

  it('counts real USDC movement as counterparty_verified', () => {
    expect(classifyProvenance(row({ economic_impact_usdc: 0.1 }))).toBe('counterparty_verified');
    expect(classifyProvenance(row({ economic_impact_usdc: '0.5' }))).toBe('counterparty_verified');
  });

  // THE ATTACK: claim to be a settlement while proving nothing.
  it('does NOT trust an event that merely calls itself economic', () => {
    const forged = row({ event_type: 'SERVICE_SATISFIED', contract_id: null, eas_attestation_id: null, economic_impact_usdc: 0 });
    expect(classifyProvenance(forged)).not.toBe('counterparty_verified');
    expect(classifyProvenance(forged)).toBe('unclassified');
  });

  it('does NOT let a self-awardable type claim on-chain status without an artifact', () => {
    expect(classifyProvenance(row({ event_type: 'CODE_CONTRIBUTION' }))).toBe('self_reported_unbacked');
  });

  it('zero or negative USDC is not evidence of a counterparty', () => {
    for (const v of [0, '0', -1, null, undefined, 'abc']) {
      expect(classifyProvenance(row({ event_type: 'STAKE', economic_impact_usdc: v as any })))
        .toBe('self_reported_unbacked');
    }
  });

  it('whitespace-only ids do not count as evidence', () => {
    expect(classifyProvenance(row({ event_type: 'REFERRAL', contract_id: '   ', eas_attestation_id: '' })))
      .toBe('self_reported_unbacked');
  });
});

describe('engine-internal scoring is never external evidence', () => {
  it('classifies HAL_SCORE_EVENT as internal, even when decorated with an attestation', () => {
    // 29,906 of 30,200 events in 30 days are this type. If a stray attestation id
    // could promote them, the decomposition would invert entirely.
    expect(classifyProvenance(row({ event_type: 'HAL_SCORE_EVENT', eas_attestation_id: '0xabc', contract_id: 'c-1' })))
      .toBe('internal_scoring');
  });

  it('internal_scoring is not externally verifiable', () => {
    expect(isExternallyVerifiable('internal_scoring')).toBe(false);
  });

  it('genesis is kept separate so it cannot flatter the counterparty count', () => {
    expect(classifyProvenance(row({ event_type: 'GENESIS', delta: -20 }))).toBe('genesis');
    expect(isExternallyVerifiable('genesis')).toBe(false);
  });
});

describe('self-report tiers', () => {
  it('an evidence ref upgrades unbacked -> with_evidence, and only that far', () => {
    const claim = row({ event_type: 'AGENT_TEACHING' });
    expect(classifyProvenance(claim)).toBe('self_reported_unbacked');

    const backed = { ...claim, metadata: { evidence: { kind: 'cosign', ref: 'artifact-9' } } };
    expect(classifyProvenance(backed)).toBe('self_reported_with_evidence');
    // Still not externally verifiable — a self-supplied ref is not a counterparty.
    expect(isExternallyVerifiable('self_reported_with_evidence')).toBe(false);
  });

  it('rejects malformed evidence blocks', () => {
    for (const ev of [null, 'ref', 42, {}, { ref: '' }, { ref: '  ' }, { ref: 5 }, []]) {
      expect(hasEvidenceRef(row({ metadata: { evidence: ev } } as any))).toBe(false);
    }
  });

  it('covers every self-awardable type from FIXED_DELTAS', () => {
    for (const t of SELF_AWARDABLE_EVENT_TYPES) {
      expect(classifyProvenance(row({ event_type: t }))).toBe('self_reported_unbacked');
    }
  });
});

describe('unrecognised shapes are surfaced, never absorbed', () => {
  it('reports unclassified rather than defaulting to something reassuring', () => {
    expect(classifyProvenance(row({ event_type: 'BRAND_NEW_THING' }))).toBe('unclassified');
    expect(classifyProvenance(row({ event_type: null }))).toBe('unclassified');
    expect(isExternallyVerifiable('unclassified')).toBe(false);
  });
});

describe('summarizeProvenance', () => {
  it('decomposes a mixed ledger and does not lose events', () => {
    const rows: ScoreEventRow[] = [
      row({ event_type: 'SERVICE_SATISFIED', contract_id: 'c1', delta: 22 }),
      row({ event_type: 'SERVICE_FULFILLED', contract_id: 'c2', delta: 10 }),
      row({ event_type: 'VALIDATOR_REWARD', eas_attestation_id: '0x1', delta: 40 }),
      row({ event_type: 'AGENT_TEACHING', delta: 15 }),
      row({ event_type: 'HAL_SCORE_EVENT', delta: -1 }),
      row({ event_type: 'HAL_SCORE_EVENT', delta: 0 }),
    ];
    const b = summarizeProvenance(rows);

    expect(b.totalEvents).toBe(6);
    // every event lands in exactly one class
    expect(Object.values(b.byClass).reduce((a, x) => a + x.events, 0)).toBe(6);
    expect(b.totalNetDelta).toBe(86);
    expect(b.externallyVerifiable.events).toBe(3);
    expect(b.externallyVerifiable.netDelta).toBe(72);
    expect(b.unbackedSelfReported).toEqual({ events: 1, netDelta: 15 });
    expect(b.byClass.internal_scoring.events).toBe(2);
    // 72 verifiable of 87 positive
    expect(b.verifiableShareOfGains).toBeCloseTo(72 / 87, 5);
  });

  // Penalties are not credibility. A heavily-penalised agent must not look
  // better-evidenced than a clean one.
  it('computes the verifiable share over POSITIVE delta only', () => {
    const b = summarizeProvenance([
      row({ contract_id: 'c1', delta: 10 }),
      row({ event_type: 'VALIDATION_FAILED', contract_id: 'c2', delta: -250 }),
      row({ event_type: 'AGENT_TEACHING', delta: 10 }),
    ]);
    expect(b.verifiableShareOfGains).toBeCloseTo(0.5, 5);
    expect(b.totalNetDelta).toBe(-230);
  });

  it('returns null share when there are no gains, rather than 0 or NaN', () => {
    expect(summarizeProvenance([]).verifiableShareOfGains).toBeNull();
    expect(summarizeProvenance([row({ event_type: 'HAL_SCORE_EVENT', delta: -1 })]).verifiableShareOfGains).toBeNull();
  });

  it('treats a non-numeric delta as 0 instead of poisoning the totals with NaN', () => {
    const b = summarizeProvenance([row({ contract_id: 'c1', delta: 'oops' as any })]);
    expect(b.totalNetDelta).toBe(0);
    expect(Number.isNaN(b.totalNetDelta)).toBe(false);
  });
});

describe('describeProvenance', () => {
  it('states the internal-churn share out loud rather than omitting it', () => {
    const s = describeProvenance(summarizeProvenance([
      row({ contract_id: 'c1', delta: 10 }),
      row({ event_type: 'HAL_SCORE_EVENT', delta: -1 }),
      row({ event_type: 'AGENT_TEACHING', delta: 15 }),
    ]));
    expect(s).toMatch(/internal scoring 1 events/);
    expect(s).toMatch(/unbacked self-reported \+15/);
    expect(s).toMatch(/externally verifiable/);
  });
});
