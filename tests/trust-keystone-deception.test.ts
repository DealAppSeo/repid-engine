/**
 * trust-keystone-deception — Trust Harness P1 KEYSTONE (M1) engine tests.
 *
 * Drives the REAL updateRepId() with its layers + DB mocked, and asserts the
 * asymmetric-deception invariants:
 *   (a) shadow mode logs the would-be delta but does NOT change current_repid;
 *   (b) enforce mode applies the heavy delta;
 *   (c) ordinary error gets the LIGHT penalty, defended deception the HEAVY one.
 *
 * Mirrors tests/stake-delta-gate.test.ts's mock topology.
 */

// Neutralize scoring layers so only the deception branch matters.
jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
  updateSupplyRate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: jest.fn() }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid, // no decay
  computeRedemptionModifier: jest.fn().mockResolvedValue(1.0), // no redemption damping
}));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: jest.fn().mockResolvedValue({
    enabled: false, passed: null, complianceScore: null, rulesChecked: [],
    halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0,
    mirrorTestPassed: true,
  }),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: jest.fn().mockResolvedValue([]) }));

// DB mock: capture every repid_score_events insert + every repid_agents update.
const inserted: any[] = [];
const updated: any[] = [];
jest.mock('../src/db', () => {
  const agent = { id: 'agent-1', agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };
  return {
    db: {
      from: jest.fn((table: string) => {
        if (table === 'repid_agents') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: agent, error: null }) }) }),
            update: (payload: any) => ({ eq: async () => { updated.push(payload); return { error: null }; } }),
          };
        }
        return { insert: async (row: any) => { inserted.push(row); return { error: null }; } };
      }),
    },
  };
});

import { updateRepId } from '../src/engine/repid-update';
// Pull the mocked operational side-effect fns so the shadow-inert test can assert
// they are NEVER called on the shadow-deception path (finding 1).
import { updateSupplyRate } from '../src/layers/ecosystem-need';
import { checkAndAwardBadges } from '../src/engine/badges';
const updateSupplyRateMock = updateSupplyRate as jest.Mock;
const checkAndAwardBadgesMock = checkAndAwardBadges as jest.Mock;

// A CONFIRMED, GROUNDED M2 detection — the provenance the M1 gate requires
// before it will apply the heavy -60/-40 tier (findings 4+5). Record-corrupting
// classes need grounded=true; supervision-evasion classes need only confidence
// >= the 0.6 confirm threshold.
const groundedProof = (cls: string, confidence = 0.9) => ({
  class: cls,
  confidence,
  grounded: true,
  evidence: `test grounded detection for ${cls}`,
  receiptRefs: ['0xdeadbeef'],
});

const ORIGINAL_MODE = process.env.TRUST_DECEPTION_MODE;
afterEach(() => {
  jest.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  if (ORIGINAL_MODE === undefined) delete process.env.TRUST_DECEPTION_MODE;
  else process.env.TRUST_DECEPTION_MODE = ORIGINAL_MODE;
});

describe('M1 — shadow mode logs but does NOT mutate current_repid', () => {
  it('default (no flag) => shadow: delta applied 0, would-be delta recorded', async () => {
    delete process.env.TRUST_DECEPTION_MODE; // default is shadow
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT',
      deceptionProof: groundedProof('fabricated-tool-result'),
    });
    // Applied delta is 0; score unchanged.
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    // No repid_agents update mutated the score to a new value.
    expect(updated.every((u) => u.current_repid === 1000)).toBe(true);
    // Audit row recorded the WOULD-BE heavy delta + shadow-deception mode.
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT');
    expect(row).toBeTruthy();
    expect(row.delta).toBe(0); // applied
    expect(row.repid_before).toBe(1000);
    expect(row.repid_after).toBe(1000); // honest: no move in shadow
    expect(row.metadata.mode).toBe('shadow-deception');
    expect(row.metadata.deltaComputed).toBe(-60); // would-be
    expect(row.metadata.deceptionConfirmed).toBe(true);
  });

  it('explicit shadow => same (no mutation)', async () => {
    process.env.TRUST_DECEPTION_MODE = 'shadow';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT',
      deceptionProof: groundedProof('denial-of-prior-output'),
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
  });

  // FINDING 2 — shadow must be TRULY INERT: current_repid AND activity_30d are
  // both unchanged before/after a shadow deception event.
  it('shadow deception leaves current_repid AND activity_30d UNCHANGED', async () => {
    delete process.env.TRUST_DECEPTION_MODE; // shadow
    // agent starts at current_repid=1000, activity_30d=5 (see DB mock).
    await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_FABRICATED_BENCHMARK',
      deceptionProof: groundedProof('fabricated-benchmark'),
    });
    // No repid_agents update was written at all on the shadow path — so neither
    // current_repid nor activity_30d was touched.
    expect(updated.length).toBe(0);
    // And the ledger row is a pure measurement: applied 0, before === after.
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_FABRICATED_BENCHMARK');
    expect(row.delta).toBe(0);
    expect(row.repid_before).toBe(1000);
    expect(row.repid_after).toBe(1000);
    expect(row.metadata.decayApplied).toBe(0);
  });

  // FINDING 1 — shadow must be FULLY INERT: NO operational side-effects beyond the
  // single audit row. updateSupplyRate() (repid_ecosystem_supply counters) and
  // checkAndAwardBadges() (repid_badges writes) must NOT run on the shadow path.
  it('shadow deception writes NO supply-rate and NO badge side-effect (only the audit row)', async () => {
    delete process.env.TRUST_DECEPTION_MODE; // shadow
    await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT',
      deceptionProof: groundedProof('fabricated-tool-result'),
    });
    // The two operational side-effects were skipped entirely.
    expect(updateSupplyRateMock).not.toHaveBeenCalled();
    expect(checkAndAwardBadgesMock).not.toHaveBeenCalled();
    // No repid_agents write, and exactly one audit row was inserted.
    expect(updated.length).toBe(0);
    expect(inserted.filter((i) => i.event_type === 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT').length).toBe(1);
  });

  // CONTROL: in ENFORCE mode the same event DOES run the side-effects (proving the
  // skip above is shadow-specific, not a blanket disable).
  it('enforce deception DOES run supply-rate + badge side-effects (control)', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT',
      deceptionProof: groundedProof('fabricated-tool-result'),
    });
    expect(updateSupplyRateMock).toHaveBeenCalledTimes(1);
    expect(checkAndAwardBadgesMock).toHaveBeenCalledTimes(1);
  });
});

describe('M1 — enforce mode applies the heavy delta (with a confirmed grounded proof)', () => {
  it('enforce => -60 applied for a record-corrupting class', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_FABRICATED_CITATION',
      deceptionProof: groundedProof('fabricated-citation'),
    });
    expect(r.delta).toBe(-60);
    expect(r.repIdAfter).toBe(940); // 1000 - 60
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_FABRICATED_CITATION');
    expect(row.metadata.mode).toBe('enforce-deception');
    expect(row.metadata.deltaComputed).toBe(-60);
    expect(row.metadata.deceptionConfirmed).toBe(true);
    expect(row.delta).toBe(-60);
  });

  it('enforce => -40 applied for a supervision-evasion class (confidence >= 0.6)', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_DOUBT_ATTACK',
      // Supervision-evasion classes are heuristic; the gate needs only
      // confidence >= the 0.6 confirm threshold (grounded not required here).
      deceptionProof: { class: 'doubt-attack', confidence: 0.6, grounded: false, evidence: 'confirmed heuristic', receiptRefs: [] },
    });
    expect(r.delta).toBe(-40);
    expect(r.repIdAfter).toBe(960);
  });
});

describe('M1 findings 3+4+5 — no penalty at all without a confirmed grounded detection', () => {
  // FINDING 3: an UNCONFIRMED (no proof / below-threshold / ungrounded-heuristic)
  // deception signal is LOG-ONLY, delta 0 — it must NOT dock an honest agent. The
  // old behavior collapsed to the ordinary-error -8, which still eroded reputation
  // on a heuristic false-positive during honest debate. A negative delta is now
  // reserved for CONFIRMED grounded detections (the -60 / -40 tiers).
  it('below-threshold DOUBT_ATTACK@0.55 gets delta 0 (advisory log-only), NOT -8/-40', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce'; // even in enforce, an unconfirmed hit is advisory
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_DOUBT_ATTACK',
      deceptionProof: { class: 'doubt-attack', confidence: 0.55, grounded: false, evidence: 'heuristic below confirm threshold', receiptRefs: [] },
    });
    // 0.55 < 0.6 confirm threshold → log-only advisory (delta 0), never a penalty.
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000); // honest agent NOT docked
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_DOUBT_ATTACK');
    expect(row.metadata.deceptionConfirmed).toBe(false);
    expect(row.delta).toBe(0); // advisory recorded, no penalty applied
  });

  it('a deception event with NO proof is log-only advisory (delta 0, never -60/-8)', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT',
      // no deceptionProof supplied
    });
    expect(r.delta).toBe(0); // advisory log-only, not -60 and not -8
    expect(r.repIdAfter).toBe(1000); // honest agent NOT docked
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT');
    expect(row.metadata.deceptionConfirmed).toBe(false);
  });

  it('a record-corrupting class with an UNGROUNDED (heuristic) proof gets delta 0 (cannot reach -60)', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_STORY_CHANGE',
      deceptionProof: { class: 'story-change-across-turns', confidence: 0.9, grounded: false, evidence: 'high conf but not grounded', receiptRefs: [] },
    });
    // -60 requires grounded=true. Ungrounded → log-only advisory, delta 0.
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000); // honest agent NOT docked
  });
});

describe('M1 — asymmetry: ordinary error LIGHT, defended deception HEAVY', () => {
  it('ordinary error (UNSUPPORTED_CLAIM) applies the light penalty', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce'; // enforce so we can compare applied deltas
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM' });
    expect(r.delta).toBe(-8); // light baseline
    expect(r.repIdAfter).toBe(992);
  });

  it('defended deception (confirmed+grounded) is markedly heavier than ordinary error', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const light = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM' });
    const heavy = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_STORY_CHANGE',
      deceptionProof: groundedProof('story-change-across-turns'),
    });
    expect(Math.abs(heavy.delta)).toBeGreaterThan(Math.abs(light.delta) * 3);
    expect(light.delta).toBe(-8);
    expect(heavy.delta).toBe(-60);
  });
});
