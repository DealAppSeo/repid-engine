const requirements = {
    scheme: 'exact',
    network: 'base-sepolia',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
    maxAmountRequired: '100000',
    resource: '/anfis/classify'
};

const auth = {
    from: "0xdf6b8215D193b11B4903d223729c3CF7A6de271d",
    to: "0xdf6b8215D193b11B4903d223729c3CF7A6de271d",
    value: "100000",
    validAfter: "0",
    validBefore: "1778742881",
    nonce: "0x0d9ccf753989aad7a3ef429908f947374ce712799b5ee41220fbeb6c775616bb"
};

async function testShape(paymentPayload: any, label: string, reqs: any, extraRootProps: any = {}) {
    const response = await fetch('https://x402.org/facilitator/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            x402Version: 1,
            paymentPayload,
            paymentRequirements: reqs,
            ...extraRootProps
        })
    });
    const body = await response.json();
    console.log(`[${label}] Status: ${response.status}, Body:`, body);
}

async function run() {
    const domain = {
        name: "USD Coin",
        version: "2",
        chainId: 84532,
        verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    };

    const p1 = { 
        x402Version: 1, 
        scheme: 'exact', 
        network: 'base-sepolia', 
        payload: { signature: "0x123", authorization: auth }
    };
    
    const p2 = { x402Version: 1, scheme: 'exact', network: 'base-sepolia', payload: { signature: "0x123", authorization: auth } };
    
    const typedDataPayload = {
        signature: "0x123",
        authorization: auth, // Provide both to satisfy the authorization check
        message: auth,
        domain: domain,
        primaryType: "TransferWithAuthorization",
        types: {
            TransferWithAuthorization: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' }
        }
    };

    // Fuzz snake_case eip712_domain
    const snakeReqs = { ...requirements, eip712_domain: domain };
    const snakePayload = { ...p2, eip712_domain: domain };
    await testShape(snakePayload, "snake_case eip712_domain", snakeReqs);
    
    // Fuzz snake_case inside payload
    await testShape({ ...p2, payload: { ...p2.payload, eip712_domain: domain } }, "snake_case payload.eip712_domain", requirements);
}

run();
