import { db } from '../../src/db';
import { x402OutboundClient } from '../../src/services/x402-outbound-client';
import { x402Facilitator } from '../../src/services/x402-facilitator';
import { ethers } from 'ethers';

const YYYYMMDD = new Date().toISOString().split('T')[0];

async function main() {
  const requestorId = 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067'; // trinity-veritas
  const providerId = '32e0e809-c1c4-4405-913f-135c8a2d6626'; // trinity-shofet
  
  const idempotencyKey = `track-4-real-1-${YYYYMMDD}`;
  const predictionTopic = 'anfis_classify_real_first_settlement';

  console.log(`Starting real settlement... idempotencyKey=${idempotencyKey}`);

  const requirements = x402Facilitator.buildPaymentRequirements({
    resource: '/anfis/classify',
    payTo: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
    priceUsdc: '100000', // 0.1 USDC
    network: 'base-sepolia',
    description: predictionTopic
  });

  // Construct EIP-3009 signed payment
  // Because we want to call the facilitator directly for the test
  // we will manually build the payment payload using the Trinity Deployer Key.
  
  const pk = process.env.TRINITY_DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("TRINITY_DEPLOYER_PRIVATE_KEY missing");
  const wallet = new ethers.Wallet(pk);
  
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 3600;
  const value = BigInt(100000);

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 84532,
    verifyingContract: requirements[0].asset
  };

  (requirements[0] as any).extra = {
    eip712Domain: domain
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
    to: requirements[0].payTo,
    value: value,
    validAfter: validAfter,
    validBefore: validBefore,
    nonce: nonce
  };

  const signature = await wallet.signTypedData(domain, types, message);
  const sig = ethers.Signature.from(signature);
  const paymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'base-sepolia',
    v: sig.v,
    r: sig.r,
    s: sig.s,
    from: wallet.address,
    to: requirements[0].payTo,
    value: value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: nonce,
    eip712Domain: domain
  };

  console.log("paymentPayload:", JSON.stringify(paymentPayload, null, 2));
  const paymentB64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  // Verify first
  console.log("Verifying payment...");
  const verifyResult = await x402Facilitator.verifyPayment(paymentB64, requirements);
  if (!verifyResult.valid) {
    console.error(`Verify failed: ${verifyResult.reason}`);
    
    // Save to failures if failed
    await db.from('x402_settlement_failures').insert({
        direction: 'inbound',
        agent_id: providerId,
        payment_payload_b64: paymentB64,
        payment_requirements: requirements,
        facilitator_response: { error: verifyResult.reason }
    });
    process.exit(1);
  }
  console.log("Verify OK! Settling payment...");

  // Settle
  try {
    const settleResult = await x402Facilitator.settlePayment(paymentB64, requirements);
    console.log(`Settled! txHash=${settleResult.txHash}`);
    
    // Wait for confirmation
    console.log("Waiting for confirmation...");
    const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
    let receipt = null;
    for (let i = 0; i < 30; i++) {
        receipt = await provider.getTransactionReceipt(settleResult.txHash);
        if (receipt) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    
    if (!receipt) {
        throw new Error("Tx did not confirm within 60s");
    }

    console.log(`Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);

    // Record into x402_settlements
    const { error: insertError } = await db.from('x402_settlements').insert({
        tip_id: `anfis:${settleResult.txHash}`,
        requestor_agent_id: requestorId,
        provider_agent_id: providerId,
        prediction_topic: predictionTopic,
        amount: 100000,
        asset: requirements[0].asset,
        payer_address: wallet.address,
        x_payment_header: paymentB64,
        is_simulated: false,
        status: 'settled',
        delivered_at: new Date().toISOString(),
        idempotency_key: idempotencyKey,
        settlement_attempt_count: 1
    });

    if (insertError) {
        console.error("Failed to insert x402_settlements:", insertError);
        process.exit(1);
    }
    
    console.log("Successfully recorded settlement into DB!");

  } catch (e) {
    console.error(`Settle failed: ${e.message}`);
    await db.from('x402_settlement_failures').insert({
        direction: 'inbound',
        agent_id: providerId,
        payment_payload_b64: paymentB64,
        payment_requirements: requirements,
        facilitator_response: { error: e.message }
    });
    process.exit(1);
  }
}

main().catch(console.error);
