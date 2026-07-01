/**
 * Unit tests for the BFT panel-verdict → RepID emitter (F4). Mocks only the DB writer (updateRepId) +
 * the db module; the gate helper isCosignGatedEvent is the REAL one (parity test).
 */
import { emitPanelVerdict, computeMajority, exemptReason, PanelVerdict } from '../src/engine/panel-cosign-emitter';
import * as repidUpdate from '../src/engine/repid-update';

// Prevent the real db/config import chain (config throws without SUPABASE_* at boot).
jest.mock('../src/db', () => ({ db: { from: jest.fn() } }));

// Partial mock: keep the real isCosignGatedEvent; stub updateRepId so no DB is touched.
jest.mock('../src/engine/repid-update', () => {
  const actual = jest.requireActual('../src/engine/repid-update');
  return {
    ...actual,
    updateRepId: jest.fn(async ({ agentId }: any) => ({
      agentId, agentName: 'test', repIdBefore: 1000, repIdAfter: 1000, delta: 0, tier: 'ESTABLISHED',
      ecosystemNeedWeight: 0, redemptionModifierApplied: false,
      constitutionalAudit: { passed: true, complianceScore: 1, halMode: 0, easAttestationId: '', easSchema: '', processingMs: 0 },
    })),
  };
});

const mockUpdate = repidUpdate.updateRepId as jest.Mock;
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
beforeEach(() => mockUpdate.mockClear());

describe('emitPanelVerdict', () => {
  test('aligned panelists → HANDOFF_COSIGN_VERIFIED', async () => {
    const v: PanelVerdict = { artifact_commit: SHA, panelists: [{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'PASS' }] };
    const r = await emitPanelVerdict(v);
    expect(r.majority).toBe('PASS');
    expect(r.emitted.every(e => e.event === 'HANDOFF_COSIGN_VERIFIED')).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledWith({ agentId: 'a', eventType: 'HANDOFF_COSIGN_VERIFIED' });
  });

  test('diverged panelist → PEER_VERIFY_WRONG_CALL', async () => {
    const v: PanelVerdict = { artifact_commit: SHA, panelists: [{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'PASS' }, { agent_id: 'c', call: 'FAIL' }] };
    const r = await emitPanelVerdict(v);
    expect(r.majority).toBe('PASS');
    expect(r.emitted.find(e => e.agent_id === 'c')?.event).toBe('PEER_VERIFY_WRONG_CALL');
    expect(mockUpdate).toHaveBeenCalledWith({ agentId: 'c', eventType: 'PEER_VERIFY_WRONG_CALL' });
  });

  test('diverged + self_flagged_uncertain → EXEMPT (no slash)', async () => {
    const v: PanelVerdict = { artifact_commit: SHA, panelists: [{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'PASS' }, { agent_id: 'c', call: 'FAIL', self_flagged_uncertain: true }] };
    const r = await emitPanelVerdict(v);
    expect(r.emitted.find(e => e.agent_id === 'c')?.event).toBe('EXEMPT');
    expect(mockUpdate).not.toHaveBeenCalledWith({ agentId: 'c', eventType: 'PEER_VERIFY_WRONG_CALL' });
  });

  test('diverged + confidence < 0.6 → EXEMPT', async () => {
    const v: PanelVerdict = { artifact_commit: SHA, panelists: [{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'PASS' }, { agent_id: 'c', call: 'FAIL', confidence: 0.4 }] };
    const r = await emitPanelVerdict(v);
    expect(r.emitted.find(e => e.agent_id === 'c')?.event).toBe('EXEMPT');
  });

  test('diverged + confidence >= 0.6 → still slashed', async () => {
    const v: PanelVerdict = { artifact_commit: SHA, panelists: [{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'PASS' }, { agent_id: 'c', call: 'FAIL', confidence: 0.9 }] };
    const r = await emitPanelVerdict(v);
    expect(r.emitted.find(e => e.agent_id === 'c')?.event).toBe('PEER_VERIFY_WRONG_CALL');
  });

  test('contested (tie) → emits nothing', async () => {
    const v: PanelVerdict = { artifact_commit: SHA, panelists: [{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'FAIL' }] };
    const r = await emitPanelVerdict(v);
    expect(r.majority).toBe('contested');
    expect(r.emitted).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('malformed → throws (fail-loud)', async () => {
    await expect(emitPanelVerdict({ artifact_commit: 'not-a-sha', panelists: [{ agent_id: 'a', call: 'PASS' }] })).rejects.toThrow(/SHA/);
    await expect(emitPanelVerdict({ artifact_commit: SHA, panelists: [] })).rejects.toThrow(/no panelists/);
    await expect(emitPanelVerdict({ artifact_commit: SHA, panelists: [{ agent_id: '', call: 'PASS' }] })).rejects.toThrow(/agent_id/);
    await expect(emitPanelVerdict({ artifact_commit: SHA, panelists: [{ agent_id: 'a', call: 'PASS', confidence: 5 }] })).rejects.toThrow(/confidence/);
    await expect(emitPanelVerdict({ artifact_commit: SHA, majority: 'FAIL', panelists: [{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'PASS' }] })).rejects.toThrow(/majority/);
  });
});

describe('gate parity (real isCosignGatedEvent)', () => {
  test('all three cosign/panel events gated together; others not', () => {
    expect(repidUpdate.isCosignGatedEvent('HANDOFF_COSIGN_VERIFIED')).toBe(true);
    expect(repidUpdate.isCosignGatedEvent('HANDOFF_COSIGN_FALSE_PASS_SLASH')).toBe(true);
    expect(repidUpdate.isCosignGatedEvent('PEER_VERIFY_WRONG_CALL')).toBe(true);
    expect(repidUpdate.isCosignGatedEvent('STAKE' as any)).toBe(false);
  });
});

describe('helpers', () => {
  test('computeMajority', () => {
    expect(computeMajority([{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'PASS' }, { agent_id: 'c', call: 'FAIL' }])).toBe('PASS');
    expect(computeMajority([{ agent_id: 'a', call: 'PASS' }, { agent_id: 'b', call: 'FAIL' }])).toBe('contested');
  });
  test('exemptReason', () => {
    expect(exemptReason({ agent_id: 'a', call: 'X', self_flagged_uncertain: true })).toMatch(/self_flagged/);
    expect(exemptReason({ agent_id: 'a', call: 'X', confidence: 0.3 })).toMatch(/confidence/);
    expect(exemptReason({ agent_id: 'a', call: 'X', confidence: 0.9 })).toBeNull();
  });
});
