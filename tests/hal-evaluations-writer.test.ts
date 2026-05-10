import { db } from '../src/db';
import { writeHalEvaluation } from '../src/services/hal-evaluations-writer';

/**
 * Mock src/db.ts to capture inserts.
 */
jest.mock('../src/db', () => {
  const chain: any = {};
  return {
    db: {
      from: jest.fn().mockReturnValue(chain),
      __chain: chain,
    },
  };
});

const mockedDb = db as any;

describe('hal-evaluations-writer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.clearAllMocks();
    
    // Set up default chain mock
    mockedDb.__chain.insert = jest.fn().mockResolvedValue({ error: null });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns immediately if HAL_EVALUATIONS_DUAL_WRITE is not true', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'false';
    await writeHalEvaluation({ mode: 'production', prompt_text: 'test' });
    expect(mockedDb.from).not.toHaveBeenCalled();

    process.env.HAL_EVALUATIONS_DUAL_WRITE = undefined;
    await writeHalEvaluation({ mode: 'production', prompt_text: 'test' });
    expect(mockedDb.from).not.toHaveBeenCalled();
  });

  test('calls insert with correct payload when enabled', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
    const params = {
      mode: 'production' as const,
      prompt_text: 'Who wrote Hamlet?',
      gen_provider: 'groq',
      gen_model: 'llama-3.1-8b',
      hal_signals: { harm: 0.1 },
      decision: 'APPROVE' as const
    };

    await writeHalEvaluation(params);

    expect(mockedDb.from).toHaveBeenCalledWith('hal_evaluations');
    const call = mockedDb.__chain.insert.mock.calls[0][0];
    expect(call.mode).toBe('production');
    expect(call.gen_provider).toBe('groq');
    expect(call.prompt_text_hash).toBeDefined();
    // SHA256 for 'Who wrote Hamlet?' starts with 1960...
    expect(call.prompt_text_hash).toHaveLength(64);
    expect(call.repid_engine_commit).toBeDefined();
  });

  test('hashes api_key if provided', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
    await writeHalEvaluation({
      mode: 'production',
      api_key: 'sk-12345'
    });
    const call = mockedDb.__chain.insert.mock.calls[0][0];
    expect(call.api_key_hash).toHaveLength(64);
    expect(call.api_key).toBeUndefined(); // Should not store raw key
  });

  test('handles db errors gracefully (does not throw)', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
    mockedDb.__chain.insert.mockResolvedValue({ error: { message: 'DB Error' } });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(writeHalEvaluation({ mode: 'production' })).resolves.not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('insert failed'), 'DB Error');
    spy.mockRestore();
  });

  test('handles unexpected exceptions gracefully', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
    mockedDb.__chain.insert.mockImplementation(() => { throw new Error('Boom'); });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(writeHalEvaluation({ mode: 'production' })).resolves.not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unexpected error'), 'Boom');
    spy.mockRestore();
  });

  // Phase 2 (MVP-BACKEND-READINESS) — Layer 0 classifier bug fixes.
  // The fixed call sites in src/hal/classifier.ts and src/hal/lib/classifier.ts
  // pass decision: undefined + hal_score: undefined + dynamic notes. The
  // following tests pin the helper's pass-through behavior for those values.
  test('Layer 0 call-site shape: decision=undefined and hal_score=undefined pass through (not coerced to APPROVE / 0)', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
    const layer0Result = {
      category: 'factual',
      confidence: 'high',
      latency_ms: 42,
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      raw: 'category: factual\nconfidence: high',
    };
    await writeHalEvaluation({
      mode: 'production',
      prompt_text: 'Who wrote Hamlet?',
      prompt_source: 'production_traffic',
      gen_provider: layer0Result.provider,
      gen_model: layer0Result.model,
      gen_latency_ms: layer0Result.latency_ms,
      hal_signals: layer0Result,
      hal_score: undefined,
      decision: undefined,
      notes: `Layer 0 classification: category=${layer0Result.category} confidence=${layer0Result.confidence}`,
    });

    const call = mockedDb.__chain.insert.mock.calls[0][0];
    expect(call.mode).toBe('production');
    expect(call.decision).toBeUndefined();
    expect(call.decision).not.toBe('APPROVE');
    expect(call.hal_score).toBeUndefined();
    expect(call.hal_score).not.toBe(0);
    // Notes must be the dynamic template, not the old static 'Layer 0 Prompt Classification'
    expect(call.notes).toBe('Layer 0 classification: category=factual confidence=high');
    expect(call.notes).not.toBe('Layer 0 Prompt Classification');
  });

  // Phase 5 (MVP-BACKEND-READINESS) — paper-trading dual-write call shape.
  // src/services/paper-trade-execution.ts calls writeHalEvaluation with
  // mode='production', decision='APPROVE'|'BLOCK', a real agent_id, and a
  // descriptive notes string. The following tests pin that payload shape.
  test('Paper-trade APPROVE call-site shape: real decision, agent_id, hashed rationale', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
    const agentId = '11111111-2222-3333-4444-555555555555';
    const rationale = 'AAPL momentum on guidance; 5d MA crossover with rising volume.';
    await writeHalEvaluation({
      mode: 'production',
      prompt_text: rationale,
      prompt_source: 'production_traffic',
      agent_id: agentId,
      decision: 'APPROVE',
      notes: `Paper trade APPROVED: buy 10 AAPL via TrustTrader (notional≈1500.00, authority=2000, cap=75%, bet_id=bet_test_xyz)`,
    });

    const call = mockedDb.__chain.insert.mock.calls[0][0];
    expect(call.mode).toBe('production');
    expect(call.agent_id).toBe(agentId);
    expect(call.decision).toBe('APPROVE');
    expect(call.prompt_source).toBe('production_traffic');
    expect(call.prompt_text_hash).toHaveLength(64);
    expect(call.prompt_text).toBeUndefined(); // never persist raw rationale
    expect(call.notes).toContain('Paper trade APPROVED');
    expect(call.notes).toContain('AAPL');
  });

  test('Paper-trade BLOCK call-site shape: decision=BLOCK passes through', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
    const agentId = '11111111-2222-3333-4444-555555555555';
    await writeHalEvaluation({
      mode: 'production',
      prompt_text: 'TSLA bear flag short.',
      prompt_source: 'production_traffic',
      agent_id: agentId,
      decision: 'BLOCK',
      notes: 'Paper trade BLOCKED by stake-authority cap: sell 100 TSLA via TrustTrader (notional≈25000.00, allowed≈10000.00, authority=20000, cap=50%)',
    });

    const call = mockedDb.__chain.insert.mock.calls[0][0];
    expect(call.decision).toBe('BLOCK');
    expect(call.agent_id).toBe(agentId);
    expect(call.notes).toContain('BLOCKED by stake-authority cap');
  });
});
