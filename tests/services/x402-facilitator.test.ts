import { x402Facilitator, PaymentRequirements } from '../../src/services/x402-facilitator';
import { ethers } from 'ethers';

// verifyPayment/settlePayment call resolveAndVerifyDomain(), which reads name()/version()
// off a real ethers Contract bound to a live Base Sepolia JsonRpcProvider from getProvider().
// Mocking global.fetch does NOT intercept that — ethers uses its own transport — so before
// this mock the suite made a real RPC call and only reached its assertions once that call
// FAILED into the NODE_ENV==='test' fallback inside the catch. When the endpoint was slow to
// fail instead of fast, the test blew jest's 5s limit: a required check whose result depended
// on public-RPC latency, not on any code under test. Observed as an intermittent
// "Exceeded timeout of 5000 ms" on an unrelated docs-only PR (#266).
//
// The two sibling x402 suites already stub this boundary (x402-recovery-worker mocks the
// facilitator, x402-outbound-client mocks ethers); this file was the only one left live.
// The returned name/version are exactly what the catch-fallback produced, so the envelope
// assertions below are unchanged — this pins the value instead of racing for it.
// ethers itself is deliberately NOT mocked: the v,r,s test needs real signing.
jest.mock('../../src/services/x402-outbound-client', () => ({
  resolveAndVerifyDomain: jest.fn(async (tokenAddress: string, chainId: number) => ({
    name: 'USDC',
    version: '2',
    chainId,
    verifyingContract: tokenAddress,
    domainSeparator: '0x'.padEnd(66, '0'),
    verifiedAt: Date.now(),
  })),
}));

describe('X402Facilitator Envelope Shape Tests', () => {
  let originalFetch: typeof global.fetch;
  let lastRequestBody: any = null;

  beforeEach(() => {
    originalFetch = global.fetch;
    lastRequestBody = null;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const mockRequirements: PaymentRequirements = {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '100000',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0xf6eE1768868c3266868edcA78bC41C50309cb22A',
    resource: '/api/v1/test',
    mimeType: 'application/json',
    maxTimeoutSeconds: 3600
  };

  const sampleFlatPayment = {
    from: '0xf6eE1768868c3266868edcA78bC41C50309cb22A',
    to: '0x15eB9A7427f1B54486926465d5895cD51eB8b052',
    value: '100000',
    validAfter: '0',
    validBefore: '1716500000',
    nonce: '0x123',
    txHash: '0xsignaturestring'
  };

  test('verifyPayment maps flat payment to SHAPE C envelope with single requirement object', async () => {
    const headerB64 = Buffer.from(JSON.stringify(sampleFlatPayment)).toString('base64');

    global.fetch = jest.fn().mockImplementation(async (url: any, init: any) => {
      lastRequestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ valid: true, payer: sampleFlatPayment.from }), { status: 200 });
    });

    const result = await x402Facilitator.verifyPayment(headerB64, [mockRequirements]);

    expect(result.valid).toBe(true);
    expect(result.payer).toBe(sampleFlatPayment.from);

    // Validate x402 v2 envelope (migrated 2026-07-22, PR #178 — see buildV2Envelope).
    // The live x402.org facilitator rejected the old top-level scheme/network shape
    // (that omission was the live "reading 'scheme'" 500). In v2: scheme/network/amount
    // live inside paymentPayload.accepted, authorization numeric fields are strings,
    // and paymentRequirements mirrors `accepted` (uses `amount`, not maxAmountRequired).
    expect(lastRequestBody).toBeDefined();
    expect(lastRequestBody.x402Version).toBe(2);
    expect(lastRequestBody.paymentPayload).toBeDefined();
    expect(lastRequestBody.paymentPayload.x402Version).toBe(2);
    expect(lastRequestBody.paymentPayload.accepted).toBeDefined();
    expect(lastRequestBody.paymentPayload.accepted.scheme).toBe('exact');
    expect(lastRequestBody.paymentPayload.accepted.network).toBe('base-sepolia');
    expect(lastRequestBody.paymentPayload.accepted.amount).toBe('100000');
    expect(lastRequestBody.paymentPayload.payload).toBeDefined();
    expect(lastRequestBody.paymentPayload.payload.signature).toBe('0xsignaturestring');
    expect(lastRequestBody.paymentPayload.payload.authorization).toEqual({
      from: sampleFlatPayment.from,
      to: sampleFlatPayment.to,
      value: '100000',
      validAfter: '0',
      validBefore: '1716500000',
      nonce: sampleFlatPayment.nonce
    });
    expect(lastRequestBody.paymentRequirements).not.toBeInstanceOf(Array);
    expect(lastRequestBody.paymentRequirements).toEqual({
      scheme: 'exact',
      network: 'base-sepolia',
      amount: '100000',
      asset: mockRequirements.asset,
      payTo: mockRequirements.payTo,
      maxTimeoutSeconds: mockRequirements.maxTimeoutSeconds,
      extra: {
        assetTransferMethod: 'eip3009',
        name: 'USDC',
        version: '2'
      }
    });
  });

  test('settlePayment maps flat payment to SHAPE C envelope and handles arrays consistently', async () => {
    const headerB64 = Buffer.from(JSON.stringify(sampleFlatPayment)).toString('base64');

    global.fetch = jest.fn().mockImplementation(async (url: any, init: any) => {
      lastRequestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ success: true, txHash: '0xsettledtx', network: 'base-sepolia', payer: sampleFlatPayment.from }), { status: 200 });
    });

    const result = await x402Facilitator.settlePayment(headerB64, [mockRequirements]);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xsettledtx');

    // Validate x402 v2 envelope (see verifyPayment test above for the full rationale).
    expect(lastRequestBody).toBeDefined();
    expect(lastRequestBody.x402Version).toBe(2);
    expect(lastRequestBody.paymentPayload).toBeDefined();
    expect(lastRequestBody.paymentPayload.x402Version).toBe(2);
    expect(lastRequestBody.paymentPayload.accepted.scheme).toBe('exact');
    expect(lastRequestBody.paymentPayload.accepted.network).toBe('base-sepolia');
    expect(lastRequestBody.paymentPayload.payload).toBeDefined();
    expect(lastRequestBody.paymentPayload.payload.signature).toBe('0xsignaturestring');
    // v2: authorization numeric fields are strings on the wire.
    expect(lastRequestBody.paymentPayload.payload.authorization.validBefore).toBe('1716500000');
    expect(lastRequestBody.paymentRequirements).not.toBeInstanceOf(Array);
    expect(lastRequestBody.paymentRequirements).toEqual({
      scheme: 'exact',
      network: 'base-sepolia',
      amount: '100000',
      asset: mockRequirements.asset,
      payTo: mockRequirements.payTo,
      maxTimeoutSeconds: mockRequirements.maxTimeoutSeconds,
      extra: {
        assetTransferMethod: 'eip3009',
        name: 'USDC',
        version: '2'
      }
    });
  });

  test('constructs EIP-712 signature from v,r,s if txHash is missing', async () => {
    const wallet = ethers.Wallet.createRandom();
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: 84532,
      verifyingContract: mockRequirements.asset
    };
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    };
    const message = {
      from: wallet.address,
      to: '0x15eB9A7427f1B54486926465d5895cD51eB8b052',
      value: 100000n,
      validAfter: 0,
      validBefore: 1716500000,
      nonce: ethers.hexlify(ethers.randomBytes(32))
    };
    const signature = await wallet.signTypedData(domain, types, message);
    const sig = ethers.Signature.from(signature);

    const paymentWithVrs = {
      v: sig.v,
      r: sig.r,
      s: sig.s,
      from: wallet.address,
      to: message.to,
      value: '100000',
      validAfter: '0',
      validBefore: '1716500000',
      nonce: message.nonce
    };

    const headerB64 = Buffer.from(JSON.stringify(paymentWithVrs)).toString('base64');

    global.fetch = jest.fn().mockImplementation(async (url: any, init: any) => {
      lastRequestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ valid: true, payer: paymentWithVrs.from }), { status: 200 });
    });

    await x402Facilitator.verifyPayment(headerB64, mockRequirements);

    expect(lastRequestBody).toBeDefined();
    expect(lastRequestBody.paymentPayload.payload.signature).toBe(signature);
  });
});
