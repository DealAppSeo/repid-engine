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
});
