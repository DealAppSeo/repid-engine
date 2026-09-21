/**
 * Tests for the proof-tier shadow gate (item 11).
 * The gate is always inert in prod unless PROOF_TIER_SHADOW_ENABLED=true.
 */

import { shadowProofTier } from '../../src/scoring/proof-tier-shadow';

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = OLD_ENV;
  jest.restoreAllMocks();
});

describe('shadowProofTier', () => {
  it('returns without logging when gate is off (default)', async () => {
    delete process.env['PROOF_TIER_SHADOW_ENABLED'];
    await shadowProofTier('CHALLENGE', 'ESTABLISHED');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('logs a PROOF-TIER-SHADOW entry for a high-stakes CHALLENGE event', async () => {
    process.env['PROOF_TIER_SHADOW_ENABLED'] = 'true';
    await shadowProofTier('CHALLENGE', 'ESTABLISHED');
    expect(console.log).toHaveBeenCalledWith(
      '[PROOF-TIER-SHADOW]',
      expect.stringContaining('"eventType":"CHALLENGE"'),
    );
    const logged = (console.log as jest.Mock).mock.calls[0][1] as string;
    const parsed = JSON.parse(logged);
    expect(parsed.tier).toBeTruthy();
    expect(typeof parsed.tierIndex).toBe('number');
    expect(Array.isArray(parsed.drivers)).toBe(true);
  });

  it('logs a lower tier for a low-stakes REFERRAL event', async () => {
    process.env['PROOF_TIER_SHADOW_ENABLED'] = 'true';
    await shadowProofTier('REFERRAL', 'PROBATIONARY');
    const logged = (console.log as jest.Mock).mock.calls[0][1] as string;
    const parsed = JSON.parse(logged);
    // REFERRAL has stakes=0.35, which should resolve below CHALLENGE's higher tier
    expect(parsed.tierIndex).toBeLessThanOrEqual(2);
  });

  it('gives VETERAN agents a stakes bonus', async () => {
    process.env['PROOF_TIER_SHADOW_ENABLED'] = 'true';
    // STAKE event for VETERAN — stakes= min(0.9+0.15, 1) = 1.0
    await shadowProofTier('STAKE', 'VETERAN');
    const logged = (console.log as jest.Mock).mock.calls[0][1] as string;
    const parsed = JSON.parse(logged);
    expect(parsed.axes.stakes).toBe(1.0);
  });

  it('never throws on an unknown event type', async () => {
    process.env['PROOF_TIER_SHADOW_ENABLED'] = 'true';
    await expect(shadowProofTier('UNKNOWN_EVENT', 'ESTABLISHED')).resolves.toBeUndefined();
  });
});
