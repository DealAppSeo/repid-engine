
async function testShape() {
  const url = 'https://x402.org/facilitator/verify';
  const network = 'base-sepolia';

  const requirements = {
    scheme: 'exact',
    network: network,
    maxAmountRequired: '100000',
    payTo: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    resource: '/anfis/classify',
    description: 'ANFIS classification service',
    mimeType: 'application/json',
    maxTimeoutSeconds: 60
  };

  const fakePayload = {
    x402Version: 1,
    scheme: 'exact',
    network: network,
    payload: {
      signature: '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      authorization: {
        from: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
        to: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
        value: '100000',
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: '0x0000000000000000000000000000000000000000000000000000000000000000'
      }
    }
  };

  const shapeA = {
    x402Version: 1,
    paymentPayload: fakePayload,
    paymentRequirements: requirements
  };

  const shapeB = {
    x402Version: 1,
    paymentHeader: Buffer.from(JSON.stringify(fakePayload)).toString('base64'),
    paymentRequirements: requirements
  };

  const testRequest = async (name, body) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      console.log(`[${name}] Status: ${res.status}`);
      console.log(`[${name}] Body: ${text}`);
      return { status: res.status, text };
    } catch (e) {
      console.error(`[${name}] Fetch error: ${e.message}`);
      return { status: 0, text: e.message };
    }
  };

  console.log("Testing Shape A (paymentPayload)...");
  await testRequest('ShapeA', shapeA);

  console.log("\nTesting Shape B (paymentHeader)...");
  await testRequest('ShapeB', shapeB);
}

testShape();
