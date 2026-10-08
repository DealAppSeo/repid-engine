/**
 * mirror_test_triggered must never be FABRICATED by a disabled audit
 * (regression guard for the #1258 follow-up, CC + XC 2026-10-08).
 *
 * #1258 made the disabled constitutional-audit stub return the honest
 * NOT_CHECKED sentinel `mirrorTestPassed: false`. But repid-update.ts derived
 *   mirror_test_triggered = input.mirrorTestTriggered ?? !audit.mirrorTestPassed
 * and NO caller of updateRepId sets `mirrorTestTriggered`. So with the audit off
 * (the production default) `!false === true` was written on EVERY score event:
 * a mirror-test violation recorded for a test that never ran. badges.ts
 * computeEthics() counts that field (`mirrorTestPassRate = 1 - triggered/total`),
 * so it fabricated a catch and depressed every agent's ethics score — the same
 * defect class as a fake pass, pointed the other way (a fake CATCH).
 *
 * The fix gates the derivation on `audit.enabled`: a not-run audit triggers
 * nothing. These tests go RED if that guard is removed.
 */

const capturedInserts: any[] = [];

jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
  updateSupplyRate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: jest.fn() }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid,
  computeRedemptionModifier: jest.fn().mockResolvedValue(1.0),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: jest.fn().mockResolvedValue([]) }));

const auditMock = jest.fn();
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: (...args: unknown[]) => auditMock(...args),
}));

jest.mock('../src/db', () => {
  const agent = { id: 'agent-1', agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };
  return {
    db: {
      from: jest.fn((table: string) => {
        if (table === 'repid_agents') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: agent, error: null }) }) }),
            update: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        return { insert: async (row: any) => { capturedInserts.push(row); return { error: null }; } };
      }),
    },
  };
});

import { updateRepId } from '../src/engine/repid-update';

// main's REAL disabled-stub shape (#1258): enabled:false, mirrorTestPassed:false.
const DISABLED_AUDIT = {
  enabled: false, passed: false, complianceScore: 1.0, rulesChecked: [],
  halMode: 1, easAttestationId: '', easSchema: '', mirrorTestPassed: false, processingMs: 0,
};
// A real audit that ran and FAILED its mirror test.
const ENABLED_FAILED_MIRROR = {
  enabled: true, passed: false, complianceScore: 0.2, rulesChecked: ['r1'],
  halMode: 7, easAttestationId: 'eas-x', easSchema: 'v1', mirrorTestPassed: false, processingMs: 3,
};

afterEach(() => {
  capturedInserts.length = 0;
  auditMock.mockReset();
});

describe('mirror_test_triggered is never fabricated by a not-run audit', () => {
  it('disabled audit (production default) ⟹ mirror_test_triggered: false — not "triggered"', async () => {
    auditMock.mockResolvedValue(DISABLED_AUDIT);
    await updateRepId({ agentId: 'agent-1', eventType: 'REFERRAL', evidence: { kind: 'cosign', ref: 'a1' } } as any);
    // THE GUARD. Drop `audit.enabled ? ... : false` and this reads true
    // (!mirrorTestPassed === !false === true) — a fabricated catch on every event.
    expect(capturedInserts[0]?.mirror_test_triggered).toBe(false);
  });

  it('a real audit that FAILS its mirror test still records mirror_test_triggered: true', async () => {
    // The guard must not suppress a genuine triggered violation when the audit ran.
    auditMock.mockResolvedValue(ENABLED_FAILED_MIRROR);
    await updateRepId({ agentId: 'agent-1', eventType: 'REFERRAL', evidence: { kind: 'cosign', ref: 'a1' } } as any);
    expect(capturedInserts[0]?.mirror_test_triggered).toBe(true);
  });

  it('an explicit input.mirrorTestTriggered still wins over the audit derivation', async () => {
    auditMock.mockResolvedValue(DISABLED_AUDIT);
    await updateRepId({
      agentId: 'agent-1', eventType: 'REFERRAL', evidence: { kind: 'cosign', ref: 'a1' },
      mirrorTestTriggered: true,
    } as any);
    expect(capturedInserts[0]?.mirror_test_triggered).toBe(true);
  });
});
