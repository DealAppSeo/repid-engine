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
    expect(row.metadata.mode).toBe('shadow-deception');
    expect(row.metadata.deltaComputed).toBe(-60); // would-be
  });

  it('explicit shadow => same (no mutation)', async () => {
    process.env.TRUST_DECEPTION_MODE = 'shadow';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT',
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
  });
});

describe('M1 — enforce mode applies the heavy delta', () => {
  it('enforce => -60 applied for a record-corrupting class', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_FABRICATED_CITATION',
    });
    expect(r.delta).toBe(-60);
    expect(r.repIdAfter).toBe(940); // 1000 - 60
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_FABRICATED_CITATION');
    expect(row.metadata.mode).toBe('enforce-deception');
    expect(row.metadata.deltaComputed).toBe(-60);
    expect(row.delta).toBe(-60);
  });

  it('enforce => -40 applied for a supervision-evasion class', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_DOUBT_ATTACK',
    });
    expect(r.delta).toBe(-40);
    expect(r.repIdAfter).toBe(960);
  });
});

describe('M1 — asymmetry: ordinary error LIGHT, defended deception HEAVY', () => {
  it('ordinary error (UNSUPPORTED_CLAIM) applies the light penalty', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce'; // enforce so we can compare applied deltas
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM' });
    expect(r.delta).toBe(-8); // light baseline
    expect(r.repIdAfter).toBe(992);
  });

  it('defended deception is markedly heavier than ordinary error', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const light = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM' });
    const heavy = await updateRepId({
      agentId: 'agent-1',
      eventType: 'DEFENDED_DECEPTION_STORY_CHANGE',
    });
    expect(Math.abs(heavy.delta)).toBeGreaterThan(Math.abs(light.delta) * 3);
    expect(light.delta).toBe(-8);
    expect(heavy.delta).toBe(-60);
  });
});
