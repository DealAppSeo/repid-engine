import { X402Facilitator } from '../../src/services/x402-facilitator';

describe('X402Facilitator', () => {
  let facilitator: X402Facilitator;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    facilitator = new X402Facilitator();
    originalFetch = global.fetch;
    process.env.X402_FACILITATOR_URL = 'https://custom-facilitator.org';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.X402_FACILITATOR_URL;
  });

  const testHeader = Buffer.from(JSON.stringify({ txHash: '0x123' })).toString('base64');
  const testRequirements = [{
    scheme: 'exact' as const,
    network: 'base-sepolia' as const,
    maxAmountRequired: '100',
    asset: '0xUSDC',
    payTo: '0xReceiver',
    resource: '/test',
    mimeType: 'application/json'
  }];

  it('should use X402_FACILITATOR_URL env variable', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid: true, payer: '0xPayer', reason: '' })
    });
    global.fetch = mockFetch as any;

    const result = await facilitator.verifyPayment(testHeader, testRequirements);
    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://custom-facilitator.org/verify'),
      expect.any(Object)
    );
  });

  it('should retry up to 3 times on failure and succeed if subsequent succeeds', async () => {
    let callCount = 0;
    const mockFetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error')
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ valid: true, payer: '0xPayer', reason: '' })
      });
    });
    global.fetch = mockFetch as any;

    // Use a short cooldown / mock set timeouts to avoid long test delays
    jest.useFakeTimers();
    const promise = facilitator.verifyPayment(testHeader, testRequirements);

    // Fast forward for the retries
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.valid).toBe(true);
    expect(callCount).toBe(3);
    jest.useRealTimers();
  });

  it('should trip circuit breaker after 3 consecutive failures', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error')
    });
    global.fetch = mockFetch as any;

    jest.useFakeTimers();
    const promise = facilitator.verifyPayment(testHeader, testRequirements);
    await jest.runAllTimersAsync();
    const result = await promise;

    // verifyPayment catches errors and returns valid: false
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Facilitator error: 500');

    // Breaker should now be OPEN
    const breaker = facilitator.getBreakerState();
    expect(breaker.state).toBe('OPEN');

    // Next call should immediately fast-fail without calling fetch
    mockFetch.mockClear();
    const result2 = await facilitator.verifyPayment(testHeader, testRequirements);
    expect(result2.valid).toBe(false);
    expect(result2.reason).toBe('FACILITATOR_CIRCUIT_BREAKER_OPEN');
    expect(mockFetch).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});
