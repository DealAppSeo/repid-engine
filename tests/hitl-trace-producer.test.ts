/**
 * feat/cc-2026-06-16-escalation-trace-producer — unit tests.
 *
 * Verifies that `maybeCreateHitlForHalVerdict` creates a HITL request whose
 * context.sbfa.trace is present when a HAL/SBFA decision crosses the human-trigger
 * threshold (score ABOVE hal_hitl_threshold, OR sbfa.decision = 'escalate'/'abstain').
 *
 * Threshold direction confirmed: ABOVE hal_hitl_threshold = human auditor needed
 * (GA CORRECTED direction). Default threshold 0.7 (read from repid_config, fallback).
 *
 * Test layout note: tests/ is the only root Jest picks up (jest.config.js pins it).
 */

// ---------------------------------------------------------------------------
// Mocks — must precede imports (jest.mock is hoisted)
// ---------------------------------------------------------------------------

const mockCreateRequest = jest.fn(async () => ({ id: 'hitl-uuid-001', created: true }));

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }), // no config row → default threshold
  };
  return { db: { from: () => chain } };
});

jest.mock('../src/services/hitl-service', () => ({
  hitlService: { createRequest: mockCreateRequest },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { maybeCreateHitlForHalVerdict } from '../src/scoring/pipeline';
import type { HalEvaluationResponse } from '../src/hal/service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal HalEvaluationResponse with an optional sbfa field.
 * Only the fields the producer actually reads need to be present.
 */
function makeHalEval(overrides: Partial<HalEvaluationResponse> = {}): HalEvaluationResponse {
  const defaultSbfa: HalEvaluationResponse['sbfa'] = {
    decision: 'hold',
    belief: 0.6,
    belief_not: 0.2,
    ignorance_mass: 0.2,
    confidence: 0.8,
    weighted_agreement: 0.75,
    escalate_to: null,
    correlated_warning: false,
    comma_conservative: false,
    reliability_source: 'constant-oracle-test',
    enforced: false,
    trace: {
      votes: [],
      fused: { belief_act: 0.6, belief_not: 0.2, ignorance_mass: 0.2 },
      weighted_agreement: 0.75,
      act_threshold: 0.67,
      ignorance_cap: 0.45,
      min_confidence: 0.5,
      stakes: 'medium',
      action: 'protective',
      reliability_source: 'constant-oracle-test',
      flags: { correlated_warning: false, comma_conservative: false, near_deadlock_triggered: false },
      lines: ['Test trace line 1', 'Test trace line 2'],
    },
    honesty: {
      prompt_hash: 'abc123',
      decision_text_hash: 'def456',
      nonce: 'nonce-xyz',
      timestamp: new Date().toISOString(),
    },
  };
  return {
    hal_score: 0.4,
    decision: 'flagged',
    mode: 'fact-check',
    strictness: 2,
    product: 'default',
    signals: {},
    latency_ms: 50,
    sbfa: defaultSbfa,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCreateRequest.mockClear();
  delete process.env.HITL_TRACE_PRODUCER;
});

afterEach(() => {
  delete process.env.HITL_TRACE_PRODUCER;
});

describe('maybeCreateHitlForHalVerdict — threshold direction (ABOVE)', () => {
  test('score ABOVE default threshold (0.7) → creates HITL request with sbfa.trace present', async () => {
    const halEval = makeHalEval({ hal_score: 0.85, decision: 'vetoed' });
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.85,
      halEval,
      agentId: 'test-agent-001',
      scoreEventId: 42,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBeDefined();
    expect(mockCreateRequest).toHaveBeenCalledTimes(1);

    const call = mockCreateRequest.mock.calls[0][0];
    // Verify the sbfa trace is present in the context
    expect(call.context.sbfa).toBeDefined();
    expect(call.context.sbfa?.trace).toBeDefined();
    expect(call.context.sbfa?.trace.lines).toContain('Test trace line 1');
    // Reason should be score-based
    expect(call.reason).toBe('hal_score_above_threshold');
  });

  test('score BELOW default threshold (0.7) and sbfa.decision=hold → NO HITL request', async () => {
    const halEval = makeHalEval({ hal_score: 0.4, decision: 'flagged' }); // sbfa.decision='hold' (default)
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.4,
      halEval,
      agentId: 'test-agent-002',
    });

    expect(result).toBeNull();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  test('score AT threshold (0.7) → NOT triggered (above means strictly greater than)', async () => {
    const halEval = makeHalEval({ hal_score: 0.7 });
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.7,
      halEval,
      agentId: 'test-agent-003',
    });

    expect(result).toBeNull();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });
});

describe('maybeCreateHitlForHalVerdict — sbfa.decision triggers', () => {
  test('sbfa.decision=escalate → creates HITL with reason=sbfa_escalate even if score is low', async () => {
    const halEval = makeHalEval({
      hal_score: 0.3, // well below threshold
      sbfa: {
        ...makeHalEval().sbfa!,
        decision: 'escalate',
        escalate_to: 'contested_bft',
      },
    });
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.3,
      halEval,
      agentId: 'test-agent-004',
    });

    expect(result).not.toBeNull();
    expect(mockCreateRequest).toHaveBeenCalledTimes(1);
    const call = mockCreateRequest.mock.calls[0][0];
    expect(call.reason).toBe('sbfa_escalate');
    expect(call.context.sbfa?.decision).toBe('escalate');
    expect(call.context.sbfa?.trace).toBeDefined();
    // escalation priority is higher
    expect(call.priority).toBe(8);
  });

  test('sbfa.decision=abstain → creates HITL with reason=sbfa_abstain', async () => {
    const halEval = makeHalEval({
      hal_score: 0.2,
      decision: 'abstain',
      sbfa: { ...makeHalEval().sbfa!, decision: 'abstain' },
    });
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.2,
      halEval,
      agentId: 'test-agent-005',
    });

    expect(result).not.toBeNull();
    const call = mockCreateRequest.mock.calls[0][0];
    expect(call.reason).toBe('sbfa_abstain');
    expect(call.context.sbfa?.trace).toBeDefined();
  });
});

describe('maybeCreateHitlForHalVerdict — safety gates', () => {
  test('HITL_TRACE_PRODUCER=false → no request created even when score is above threshold', async () => {
    process.env.HITL_TRACE_PRODUCER = 'false';
    const halEval = makeHalEval({ hal_score: 0.95 });
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.95,
      halEval,
      agentId: 'test-agent-006',
    });

    expect(result).toBeNull();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  test('halEval=null → no request (no sbfa to attach)', async () => {
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.95,
      halEval: null,
      agentId: 'test-agent-007',
    });

    expect(result).toBeNull();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  test('halEval without sbfa field (extractor-only result) → no request', async () => {
    const halEval = makeHalEval({ hal_score: 0.95 });
    delete (halEval as any).sbfa; // simulate extractor path (no sbfa)
    const result = await maybeCreateHitlForHalVerdict({
      halScore: 0.95,
      halEval,
      agentId: 'test-agent-008',
    });

    expect(result).toBeNull();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  test('hitlService.createRequest throws → returns null without rethrowing (non-fatal)', async () => {
    mockCreateRequest.mockRejectedValueOnce(new Error('DB unavailable'));
    const halEval = makeHalEval({ hal_score: 0.9 });
    // Should not throw
    await expect(
      maybeCreateHitlForHalVerdict({ halScore: 0.9, halEval, agentId: 'test-agent-009' })
    ).resolves.toBeNull();
  });
});
