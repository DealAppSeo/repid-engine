/**
 * Free-tier quota shadow wiring (backlog item 9).
 *
 * Tests that the shadow logger:
 *   - Is inert when FREE_TIER_QUOTA_SHADOW_ENABLED is unset or false (no DB call, no log).
 *   - Logs nothing when the provider is within its daily call cap.
 *   - Logs a `free_quota_hit` signal when the provider would have been blocked.
 *   - Respects FREE_TIER_DAILY_CAP_DEFAULT env override.
 *   - Catches DB errors and warns rather than throwing.
 */

jest.mock('../../src/billing/free-provider-call-count', () => ({
  getFreeProviderCallsToday: jest.fn(),
}));

import { shadowFreeTierQuota } from '../../src/providers/free-tier-quota-shadow';
import { getFreeProviderCallsToday } from '../../src/billing/free-provider-call-count';

const mockGetCalls = getFreeProviderCallsToday as jest.MockedFunction<typeof getFreeProviderCallsToday>;

describe('shadowFreeTierQuota', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'];
    delete process.env['FREE_TIER_DAILY_CAP_DEFAULT'];
    mockGetCalls.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'];
    delete process.env['FREE_TIER_DAILY_CAP_DEFAULT'];
  });

  test('returns immediately without a DB call when gate is unset', async () => {
    await shadowFreeTierQuota('groq');
    expect(mockGetCalls).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('returns immediately without a DB call when FREE_TIER_QUOTA_SHADOW_ENABLED=false', async () => {
    process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'] = 'false';
    await shadowFreeTierQuota('cerebras');
    expect(mockGetCalls).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('logs nothing when provider is under the daily cap', async () => {
    process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'] = 'true';
    mockGetCalls.mockResolvedValue(100); // well under default 500
    await shadowFreeTierQuota('groq');
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('logs free_quota_hit when provider meets or exceeds the daily cap', async () => {
    process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'] = 'true';
    mockGetCalls.mockResolvedValue(500); // == default cap
    await shadowFreeTierQuota('groq');
    expect(logSpy).toHaveBeenCalledWith(
      '[FREE-TIER-QUOTA-SHADOW]',
      expect.stringContaining('"signal":"free_quota_hit"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[FREE-TIER-QUOTA-SHADOW]',
      expect.stringContaining('"provider":"groq"'),
    );
  });

  test('respects FREE_TIER_DAILY_CAP_DEFAULT env override', async () => {
    process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'] = 'true';
    process.env['FREE_TIER_DAILY_CAP_DEFAULT'] = '50';
    mockGetCalls.mockResolvedValue(50); // == override cap, should block
    await shadowFreeTierQuota('cerebras');
    expect(logSpy).toHaveBeenCalledWith(
      '[FREE-TIER-QUOTA-SHADOW]',
      expect.stringContaining('"dailyCallCap":50'),
    );
  });

  test('warns on DB error and does not throw', async () => {
    process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'] = 'true';
    mockGetCalls.mockRejectedValue(new Error('connection refused'));
    await expect(shadowFreeTierQuota('groq')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '[FREE-TIER-QUOTA-SHADOW] error (inert):',
      'connection refused',
    );
  });
});
