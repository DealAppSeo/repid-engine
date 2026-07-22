/**
 * self-report-evidence — engine-level evidence gate for caller-asserted positive
 * deltas (CC-1, 2026-07-21).
 *
 * The FIXED_DELTAS positives (REFERRAL +20, CODE_CONTRIBUTION +25, ...) are
 * awarded for a CALLER-SUPPLIED eventType with no proof — any API-key holder can
 * self-award them on the auth-gated POST /api/v1/score. This suite drives the
 * REAL updateRepId() with its layers + DB mocked and asserts the SHADOW-FIRST
 * gate:
 *
 *   shadow (DEFAULT) → unproven REFERRAL still yields +20 (NO live change), but
 *                      the audit metadata records would_gate: true.
 *   enforce          → unproven REFERRAL yields 0; a REFERRAL WITH evidence.ref
 *                      yields +20.
 *   STAKE            → still 0 (unchanged by this work).
 *
 * The critical invariant is (a): the default mode must move NO delta.
 */

// Neutralize the scoring layers so only the FIXED_DELTAS / self-report branch matters.
jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
  updateSupplyRate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: jest.fn() }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid, // no decay
  computeRedemptionModifier: jest.fn().mockResolvedValue(1.0),
}));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: jest.fn().mockResolvedValue({
    enabled: false, passed: null, complianceScore: null, rulesChecked: [],
    halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0,
    mirrorTestPassed: true,
  }),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: jest.fn().mockResolvedValue([]) }));

// DB: fetch agent, capture the audit-row insert payload, update score.
const capturedInserts: any[] = [];
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
        // repid_score_events insert — capture the row for metadata assertions.
        return { insert: async (row: any) => { capturedInserts.push(row); return { error: null }; } };
      }),
    },
  };
});

import { updateRepId } from '../src/engine/repid-update';

const ORIGINAL_ENV = process.env.SELF_REPORT_EVIDENCE_MODE;

afterEach(() => {
  jest.clearAllMocks();
  capturedInserts.length = 0;
  jest.resetModules();
  if (ORIGINAL_ENV === undefined) delete process.env.SELF_REPORT_EVIDENCE_MODE;
  else process.env.SELF_REPORT_EVIDENCE_MODE = ORIGINAL_ENV;
});

/**
 * The gate mode is read ONCE at module scope, so each mode needs a fresh module
 * instance. Re-require updateRepId under an isolated module registry with the
 * env var set, re-applying the same mocks inside the isolated registry.
 */
function loadEngineWithMode(mode?: string): typeof updateRepId {
  let fn!: typeof updateRepId;
  jest.isolateModules(() => {
    if (mode === undefined) delete process.env.SELF_REPORT_EVIDENCE_MODE;
    else process.env.SELF_REPORT_EVIDENCE_MODE = mode;
    // Re-declare mocks inside the isolated registry.
    jest.doMock('../src/layers/ecosystem-need', () => ({
      getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
      updateSupplyRate: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
    jest.doMock('../src/layers/prediction-scoring', () => ({ scorePrediction: jest.fn() }));
    jest.doMock('../src/layers/decay', () => ({
      applyDecay: (repid: number) => repid,
      computeRedemptionModifier: jest.fn().mockResolvedValue(1.0),
    }));
    jest.doMock('../src/layers/constitutional-audit', () => ({
      auditConstitutionalCompliance: jest.fn().mockResolvedValue({
        enabled: false, passed: null, complianceScore: null, rulesChecked: [],
        halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0,
        mirrorTestPassed: true,
      }),
    }));
    jest.doMock('../src/engine/badges', () => ({ checkAndAwardBadges: jest.fn().mockResolvedValue([]) }));
    jest.doMock('../src/db', () => {
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fn = require('../src/engine/repid-update').updateRepId;
  });
  return fn;
}

describe('self-report evidence gate', () => {
  it('(a) shadow (DEFAULT): unproven REFERRAL still yields +20 AND records would_gate', async () => {
    const updateRepId = loadEngineWithMode(undefined); // no env → default shadow
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'REFERRAL' });
    // DEFAULT changes NO live delta — the crux of shadow-first.
    expect(r.delta).toBe(20);
    expect(r.repIdAfter).toBe(1020);
    const meta = capturedInserts[0]?.metadata?.self_report_evidence;
    expect(meta).toEqual({ mode: 'shadow', required: true, present: false, would_gate: true });
  });

  it('(a2) shadow: REFERRAL WITH evidence.ref → +20 and would_gate false', async () => {
    const updateRepId = loadEngineWithMode('shadow');
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'REFERRAL',
      evidence: { kind: 'cosign', ref: 'cosign:abc123' },
    });
    expect(r.delta).toBe(20);
    const meta = capturedInserts[0]?.metadata?.self_report_evidence;
    expect(meta).toEqual({ mode: 'shadow', required: true, present: true, would_gate: false });
  });

  it('(b) enforce: unproven REFERRAL → 0 (delta zeroed)', async () => {
    const updateRepId = loadEngineWithMode('enforce');
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'REFERRAL' });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000); // unchanged — no free +20 without proof
    const meta = capturedInserts[0]?.metadata?.self_report_evidence;
    expect(meta).toEqual({ mode: 'enforce', required: true, present: false, would_gate: true });
  });

  it('(c) enforce: REFERRAL WITH evidence.ref → +20', async () => {
    const updateRepId = loadEngineWithMode('enforce');
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'REFERRAL',
      evidence: { kind: 'tx', ref: '0x' + 'a'.repeat(64) },
    });
    expect(r.delta).toBe(20);
    expect(r.repIdAfter).toBe(1020);
    const meta = capturedInserts[0]?.metadata?.self_report_evidence;
    expect(meta).toEqual({ mode: 'enforce', required: true, present: true, would_gate: false });
  });

  it('enforce: unproven CODE_CONTRIBUTION → 0 (gate covers the whole set)', async () => {
    const updateRepId = loadEngineWithMode('enforce');
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'CODE_CONTRIBUTION' });
    expect(r.delta).toBe(0);
  });

  it('off: unproven REFERRAL → +20 (gate disabled), metadata mode off', async () => {
    const updateRepId = loadEngineWithMode('off');
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'REFERRAL' });
    expect(r.delta).toBe(20);
    const meta = capturedInserts[0]?.metadata?.self_report_evidence;
    expect(meta).toEqual({ mode: 'off' });
  });

  it('(d) STAKE is unchanged by this work → still delta 0', async () => {
    const updateRepId = loadEngineWithMode('enforce'); // even in enforce, STAKE untouched here
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'STAKE' });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    // STAKE is not a self-reported evidence type — no self_report_evidence metadata.
    expect(capturedInserts[0]?.metadata?.self_report_evidence).toBeNull();
  });
});
