/**
 * deception-emitter — Trust Harness P1 KEYSTONE (M3) tests.
 *
 * Proves the SHADOW deception emitter closes the M2->M1 gap without changing any
 * live RepID:
 *   (1) a fabricated-citation / denial-of-prior-output synthetic interaction →
 *       detector fires → a shadow record shows the would-be penalty (-60) while
 *       current_repid is UNCHANGED (delta applied 0, before === after);
 *   (2) an honest interaction → no detection, no record;
 *   (3) flag-off (TRUST_DECEPTION_MODE unset) → the emitter does NOTHING at all:
 *       no detector runs, no DB row is written, ran === false;
 *   (4) enforce control → the same detection DOES move current_repid (proving the
 *       shadow inertness in (1) is mode-specific, not a blanket disable).
 *
 * All fixtures are SYNTHETIC (00000000-… agent id, invented text) per the #376
 * fence — no real prod rows, agents, or scores are used.
 *
 * Mirrors tests/trust-keystone-deception.test.ts's mock topology so the REAL
 * updateRepId() runs with its layers + DB mocked.
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

// Synthetic agent (#376 fence: 00000000-… id, invented state — NOT a real row).
const SYNTHETIC_AGENT_ID = '00000000-0000-0000-0000-000000000001';
const SYNTHETIC_START_REPID = 1000;

// DB mock: capture every repid_score_events insert + every repid_agents update.
const inserted: any[] = [];
const updated: any[] = [];
jest.mock('../src/db', () => {
  const agent = {
    id: '00000000-0000-0000-0000-000000000001',
    agent_name: 'SYNTHETIC_TEST_AGENT',
    current_repid: 1000,
    activity_30d: 5,
  };
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

import {
  emitDeceptionShadow,
  deceptionEmitterMode,
} from '../src/engine/deception-emitter';

const ORIGINAL_MODE = process.env.TRUST_DECEPTION_MODE;
afterEach(() => {
  jest.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  if (ORIGINAL_MODE === undefined) delete process.env.TRUST_DECEPTION_MODE;
  else process.env.TRUST_DECEPTION_MODE = ORIGINAL_MODE;
});

describe('deceptionEmitterMode() — default OFF, explicit shadow/enforce only', () => {
  it('unset => off', () => {
    delete process.env.TRUST_DECEPTION_MODE;
    expect(deceptionEmitterMode()).toBe('off');
  });
  it('garbage value => off (never enabled by accident)', () => {
    process.env.TRUST_DECEPTION_MODE = 'yes-please';
    expect(deceptionEmitterMode()).toBe('off');
  });
  it('shadow / enforce are recognized exactly', () => {
    process.env.TRUST_DECEPTION_MODE = 'shadow';
    expect(deceptionEmitterMode()).toBe('shadow');
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    expect(deceptionEmitterMode()).toBe('enforce');
  });
});

describe('M3 — flag-OFF: the emitter does NOTHING at all (provably inert)', () => {
  it('unset flag => ran=false, no detector, no DB write', async () => {
    delete process.env.TRUST_DECEPTION_MODE;
    // A blatantly deceptive interaction that WOULD fire in shadow.
    const r = await emitDeceptionShadow({
      agentId: SYNTHETIC_AGENT_ID,
      decisionText: 'I never said the database migration deleted 4000 production rows.',
      priorReceipts: [
        { kind: 'statement', content: 'The database migration deleted 4000 production rows.' },
      ],
    });
    expect(r.ran).toBe(false);
    expect(r.mode).toBe('off');
    expect(r.recorded).toBe(false);
    expect(r.detection.class).toBe('clean'); // no detector was run
    // The DB was never touched — no audit row, no agent update.
    expect(inserted.length).toBe(0);
    expect(updated.length).toBe(0);
  });
});

describe('M3 — SHADOW: detector fires, would-be penalty recorded, current_repid UNCHANGED', () => {
  it('denial-of-prior-output → shadow record shows would-be -60, score unchanged', async () => {
    process.env.TRUST_DECEPTION_MODE = 'shadow';
    const r = await emitDeceptionShadow({
      agentId: SYNTHETIC_AGENT_ID,
      // Flat denial of a receipted prior output → record-grounded detector fires.
      decisionText: 'I never said the database migration deleted 4000 production rows.',
      priorReceipts: [
        { kind: 'statement', content: 'The database migration deleted 4000 production rows.' },
      ],
    });

    expect(r.ran).toBe(true);
    expect(r.mode).toBe('shadow');
    expect(r.confirmed).toBe(true);
    expect(r.detection.class).toBe('denial-of-prior-output');
    expect(r.detection.grounded).toBe(true);
    expect(r.eventType).toBe('DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT');
    // The penalty that WOULD apply is the heavy record-corrupting tier.
    expect(r.wouldApplyDelta).toBe(-60);
    // But NOTHING moved the score in shadow.
    expect(r.scoreMutated).toBe(false);
    expect(r.repIdBefore).toBe(SYNTHETIC_START_REPID);
    expect(r.repIdAfter).toBe(SYNTHETIC_START_REPID);

    // The audit row is a pure measurement: applied delta 0, before === after,
    // mode 'shadow-deception', would-be delta -60 recorded in metadata.
    expect(r.recorded).toBe(true);
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT');
    expect(row).toBeTruthy();
    expect(row.delta).toBe(0);
    expect(row.repid_before).toBe(SYNTHETIC_START_REPID);
    expect(row.repid_after).toBe(SYNTHETIC_START_REPID);
    expect(row.metadata.mode).toBe('shadow-deception');
    expect(row.metadata.deltaComputed).toBe(-60);
    expect(row.metadata.deceptionConfirmed).toBe(true);
    // No repid_agents write at all on the shadow path (current_repid untouched).
    expect(updated.length).toBe(0);
  });

  it('fabricated-citation (asserted as a prior receipt that does not exist) → shadow -60, score unchanged', async () => {
    process.env.TRUST_DECEPTION_MODE = 'shadow';
    const r = await emitDeceptionShadow({
      agentId: SYNTHETIC_AGENT_ID,
      decisionText: 'As I cited earlier, Smith 2023 confirms the throughput figure.',
      claimedCitation: 'Smith 2023',
      citationAssertedAsPriorReceipt: true, // claims a PRIOR receipt…
      priorReceipts: [], // …but no citation receipt exists in the record.
    });

    expect(r.confirmed).toBe(true);
    expect(r.detection.class).toBe('fabricated-citation');
    expect(r.detection.grounded).toBe(true);
    expect(r.eventType).toBe('DEFENDED_DECEPTION_FABRICATED_CITATION');
    expect(r.wouldApplyDelta).toBe(-60);
    expect(r.scoreMutated).toBe(false);
    expect(r.repIdAfter).toBe(SYNTHETIC_START_REPID);

    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_FABRICATED_CITATION');
    expect(row.delta).toBe(0);
    expect(row.repid_before).toBe(row.repid_after);
    expect(row.metadata.mode).toBe('shadow-deception');
    expect(row.metadata.deltaComputed).toBe(-60);
    expect(updated.length).toBe(0);
  });
});

describe('M3 — honest interaction: no detection, no record', () => {
  it('a clean interaction writes nothing even in shadow', async () => {
    process.env.TRUST_DECEPTION_MODE = 'shadow';
    const r = await emitDeceptionShadow({
      agentId: SYNTHETIC_AGENT_ID,
      decisionText: 'The build passed and I deployed the service to staging.',
      priorReceipts: [
        { kind: 'statement', content: 'The build passed and I deployed the service to staging.' },
      ],
    });
    expect(r.ran).toBe(true); // the emitter ran…
    expect(r.confirmed).toBe(false); // …but found nothing
    expect(r.detection.class).toBe('clean');
    expect(r.eventType).toBeNull();
    expect(r.wouldApplyDelta).toBeNull();
    expect(r.recorded).toBe(false);
    // No audit row, no agent update — an honest agent is never recorded.
    expect(inserted.length).toBe(0);
    expect(updated.length).toBe(0);
  });

  it('an honest self-correction is NOT flagged as a story change', async () => {
    process.env.TRUST_DECEPTION_MODE = 'shadow';
    const r = await emitDeceptionShadow({
      agentId: SYNTHETIC_AGENT_ID,
      decisionText: 'Correction: upon further review the migration succeeded, not failed.',
      priorReceipts: [
        { kind: 'statement', content: 'The migration failed during the deploy.' },
      ],
    });
    expect(r.confirmed).toBe(false);
    expect(r.recorded).toBe(false);
    expect(inserted.length).toBe(0);
  });
});

describe('M3 — ENFORCE control: proves the shadow inertness is mode-specific', () => {
  it('enforce => the SAME denial detection DOES move current_repid by -60', async () => {
    process.env.TRUST_DECEPTION_MODE = 'enforce';
    const r = await emitDeceptionShadow({
      agentId: SYNTHETIC_AGENT_ID,
      decisionText: 'I never said the database migration deleted 4000 production rows.',
      priorReceipts: [
        { kind: 'statement', content: 'The database migration deleted 4000 production rows.' },
      ],
    });
    expect(r.mode).toBe('enforce');
    expect(r.confirmed).toBe(true);
    expect(r.wouldApplyDelta).toBe(-60);
    // In enforce the penalty is applied: current_repid moves.
    expect(r.scoreMutated).toBe(true);
    expect(r.repIdBefore).toBe(SYNTHETIC_START_REPID);
    expect(r.repIdAfter).toBe(SYNTHETIC_START_REPID - 60); // 940
    const row = inserted.find((i) => i.event_type === 'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT');
    expect(row.delta).toBe(-60);
    expect(row.metadata.mode).toBe('enforce-deception');
    // A repid_agents write DID happen in enforce.
    expect(updated.length).toBeGreaterThan(0);
  });
});
