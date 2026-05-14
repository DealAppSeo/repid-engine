import { Router, Request, Response } from 'express';
import { x402Facilitator } from '../services/x402-facilitator';
import { repIdAttestationService } from '../services/repid-attestation';
import { db } from '../db';
import { eip712Signer } from '../services/eip712-signer';
import { ethers } from 'ethers';
import { classifyPrompt } from '../services/anfis-classifier';
import { computeHalVerdict } from '../services/hal-evaluator';
import crypto from 'crypto';

const router = Router();

// SOPHIA trade analysis demo
router.post('/:uuid/trade-analysis', async (req: Request, res: Response) => {
  const { uuid } = req.params;
  const xPaymentHeader = req.header('X-PAYMENT');

  // 1. Fetch agent (e.g. SOPHIA) to get wallet address
  // Use maybeSingle() to handle non-UUID strings gracefully (though auth-bypass check might already filter)
  const { data: agent, error: agentError } = await db
    .from('repid_agents')
    .select('id, agent_name, wallet_address, erc8004_token_id, current_repid, tier')
    .eq('id', uuid)
    .maybeSingle();

  if (agentError || !agent) {
    return res.status(404).json({ error: 'agent_not_found_or_invalid_id' });
  }

  const priceUsdc = "10000"; // 0.01 USDC
  const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const requirements = x402Facilitator.buildPaymentRequirements({
    resource,
    payTo: agent.wallet_address || '0x0000000000000000000000000000000000000000',
    priceUsdc,
    network: 'base-sepolia',
    description: `${agent.agent_name} trade analysis — verified by HyperDAG ZKP RepID`
  });

  // 2. Check for payment header
  if (!xPaymentHeader) {
    return res.status(402).json({
      x402Version: 1,
      accepts: requirements,
      error: 'Payment required'
    });
  }

  // 3. Verify payment via facilitator
  const verifyResult = await x402Facilitator.verifyPayment(xPaymentHeader, requirements);
  if (!verifyResult.valid) {
    return res.status(402).json({
      x402Version: 1,
      accepts: requirements,
      error: 'Payment verification failed',
      reason: verifyResult.reason
    });
  }

  // 4. Extract and verify caller's attestation (if present)
  const callerAttestation = x402Facilitator.extractRepIdAttestation(req);
  if (callerAttestation) {
    const attestationResult = await repIdAttestationService.verifyAttestation(callerAttestation);
    if (!attestationResult.valid) {
      return res.status(402).json({
        x402Version: 1,
        accepts: requirements,
        error: 'invalid_attestation',
        reason: attestationResult.reason
      });
    }
  }

  // 5. Deliver service
  // In Stage 1, this is a mock analysis that simulates a high-value signal.
  const analysis = {
    agent: agent.agent_name,
    timestamp: new Date().toISOString(),
    status: 'success',
    analysis: `Trade analysis for ${agent.agent_name} complete. Market conditions: Bullish. RepID leverage factor: ${(agent.current_repid / 1000).toFixed(2)}x.`,
    is_verified_by_hyperdag: true
  };

  const queryHash = ethers.keccak256(ethers.toUtf8Bytes("trade-analysis"));
  const analysisDigest = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(analysis)));

  const receipt = {
    buyerAddress: verifyResult.payer || '0x0000000000000000000000000000000000000000',
    spokespersonTokenId: BigInt(agent.erc8004_token_id || 0),
    spokespersonName: agent.agent_name,
    queryHash,
    analysisDigest,
    sentiment: 'Bullish',
    repidLeverageFactor: BigInt(agent.current_repid),
    priceUsdc: BigInt(priceUsdc),
    paymentMode: process.env.X402_FACILITATOR_MODE === 'real' ? 'usdc' : 'eip712-only',
    timestamp: BigInt(Math.floor(Date.now() / 1000))
  };

  let signedReceipt: any = null;
  try {
    const { signature, signerAddress } = await eip712Signer.signTradeReceipt(agent.agent_name, receipt);
    signedReceipt = {
      receipt: {
        ...receipt,
        spokespersonTokenId: receipt.spokespersonTokenId.toString(),
        repidLeverageFactor: receipt.repidLeverageFactor.toString(),
        priceUsdc: receipt.priceUsdc.toString(),
        timestamp: receipt.timestamp.toString()
      },
      signature,
      signerAddress
    };
  } catch (e: any) {
    console.warn(`[trade-analysis] Could not sign receipt: ${e.message}`);
  }

  // 6. Settle payment
  let txHash = '';
  try {
    const settleResult = await x402Facilitator.settlePayment(xPaymentHeader, requirements);
    txHash = settleResult.txHash;
  } catch (e: any) {
    console.error('[x402-inbound] Settlement failed, queuing for recovery:', e.message);
    await x402Facilitator.queueFailure({
      direction: 'inbound',
      agent_id: agent.id,
      payment_payload_b64: xPaymentHeader,
      payment_requirements: requirements,
      facilitator_response: { error: e.message }
    });
  }

  // 6.5 Write to x402_settlements
  const idempotencyKey = `${agent.id}:${queryHash.substring(0,16)}:${verifyResult.payer}:${Math.floor(Date.now()/3600000)}`;
  
  const { error: settlementError } = await db.from('x402_settlements').insert({
    tip_id: `trade:${txHash}`,
    requestor_agent_id: null,
    provider_agent_id: agent.id,
    prediction_topic: 'trade_analysis',
    amount: parseInt(priceUsdc),
    asset: 'USDC',
    payer_address: verifyResult.payer,
    x_payment_header: xPaymentHeader,
    is_simulated: process.env.X402_FACILITATOR_MODE !== 'real',
    status: txHash && txHash !== 'mock_tx_hash' ? 'settled' : 'pending_settlement',
    delivered_at: new Date().toISOString(),
    idempotency_key: idempotencyKey,
    settlement_attempt_count: 1
  });
  
  if (settlementError && settlementError.code !== '23505') { // Ignore unique constraint violation
    console.error('[x402-inbound] Failed to insert x402_settlements:', settlementError.message);
  }

  // 7. Write to repid_events for reputation tracking
  await db.from('repid_events').insert({
    subject_id: agent.id,
    subject_type: 'agent',
    event_type: 'x402_inbound_settled',
    reputation_delta: 5,
    event_data: {
      tx_hash: txHash,
      payer: verifyResult.payer,
      amount: priceUsdc,
      caller_attestation: callerAttestation ? {
        agent_id: callerAttestation.agent_id,
        repid: callerAttestation.repid,
        tier: callerAttestation.tier
      } : null,
      settled_at: new Date().toISOString()
    }
  });


  // 8. Generate HyperDAG's own attestation for the response
  const myAttestation = await repIdAttestationService.generateAttestation(agent.id);
  const myAttestationB64 = Buffer.from(JSON.stringify(myAttestation)).toString('base64');

  res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ status: 'settled', txHash }));
  res.setHeader('X-HYPERDAG-REPID-ATTESTATION', myAttestationB64);

  const response: any = { ...analysis };
  if (signedReceipt) {
    response.signedReceipt = signedReceipt;
  }
  return res.status(200).json(response);
});

router.post('/:uuid/anfis-classify', async (req: Request, res: Response) => {
  const { uuid } = req.params;
  const xPaymentHeader = req.body.x402_payment || req.header('X-PAYMENT');

  const { data: agent, error: agentError } = await db
    .from('repid_agents')
    .select('id, agent_name, wallet_address, erc8004_token_id, current_repid, tier')
    .eq('id', uuid)
    .maybeSingle();

  if (agentError || !agent) {
    return res.status(404).json({ error: 'agent_not_found_or_invalid_id' });
  }

  const includeHalCheck = req.body.include_hal_check === true;
  const priceUsdc = includeHalCheck ? "500000" : "100000"; // 0.5 USDC vs 0.1 USDC

  const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const requirements = x402Facilitator.buildPaymentRequirements({
    resource,
    payTo: agent.wallet_address || '0x0000000000000000000000000000000000000000',
    priceUsdc,
    network: 'base-sepolia',
    description: includeHalCheck ? `ANFIS+HAL Classification by ${agent.agent_name}` : `ANFIS Classification by ${agent.agent_name}`
  });

  if (!xPaymentHeader) {
    return res.status(402).json({
      x402Version: 1,
      accepts: requirements,
      error: 'Payment required'
    });
  }

  const verifyResult = await x402Facilitator.verifyPayment(xPaymentHeader, requirements);
  if (!verifyResult.valid) {
    return res.status(402).json({
      x402Version: 1,
      accepts: requirements,
      error: 'Payment verification failed',
      reason: verifyResult.reason
    });
  }

  const payload = req.body.payload || '';
  const classification = await classifyPrompt(payload);
  const promptHash = ethers.keccak256(ethers.toUtf8Bytes(payload));

  let halVerdict: any = null;
  if (includeHalCheck) {
    halVerdict = await computeHalVerdict(payload, classification.category);
    
    if (halVerdict.status === 'BLOCK') {
      return res.status(451).json({
        error: 'Unavailable For Legal Reasons',
        reason: 'HAL vetoed the prompt',
        veto_class: halVerdict.veto_class
      });
    }
  }

  const receipt = {
    buyerAddress: verifyResult.payer || '0x0000000000000000000000000000000000000000',
    spokespersonTokenId: BigInt(agent.erc8004_token_id || 0),
    spokespersonName: agent.agent_name,
    promptHash,
    routedProvider: classification.provider,
    confidence: Math.round(classification.confidence * 100),
    reasoning: classification.reasoning,
    priceUsdc: BigInt(priceUsdc),
    paymentMode: process.env.X402_FACILITATOR_MODE === 'real' ? 'usdc' : 'eip712-only',
    timestamp: BigInt(Math.floor(Date.now() / 1000))
  };

  let signedReceipt: any = null;
  try {
    const { signature, signerAddress } = await eip712Signer.signAnfisReceipt(agent.agent_name, receipt);
    signedReceipt = {
      receipt: {
        ...receipt,
        spokespersonTokenId: receipt.spokespersonTokenId.toString(),
        priceUsdc: receipt.priceUsdc.toString(),
        timestamp: receipt.timestamp.toString()
      },
      signature,
      signerAddress
    };
  } catch (e: any) {
    console.warn(`[anfis-classify] Could not sign receipt: ${e.message}`);
  }

  let txHash = 'mock_tx_hash';
  try {
    const settleResult = await x402Facilitator.settlePayment(xPaymentHeader, requirements);
    txHash = settleResult.txHash;
  } catch (e: any) {
    console.error('[x402-inbound] Settlement failed, queuing for recovery:', e.message);
    await x402Facilitator.queueFailure({
      direction: 'inbound',
      agent_id: agent.id,
      payment_payload_b64: xPaymentHeader,
      payment_requirements: requirements,
      facilitator_response: { error: e.message }
    });
  }

  // 6.5 Write to x402_settlements
  const idempotencyKey = `${agent.id}:${promptHash.substring(0,16)}:${verifyResult.payer}:${Math.floor(Date.now()/3600000)}`;
  
  const { error: settlementError } = await db.from('x402_settlements').insert({
    tip_id: `anfis:${txHash}`,
    requestor_agent_id: null,
    provider_agent_id: agent.id,
    prediction_topic: 'anfis_classification',
    amount: parseInt(priceUsdc),
    asset: 'USDC',
    payer_address: verifyResult.payer,
    x_payment_header: xPaymentHeader,
    is_simulated: process.env.X402_FACILITATOR_MODE !== 'real',
    status: txHash && txHash !== 'mock_tx_hash' ? 'settled' : 'pending_settlement',
    delivered_at: new Date().toISOString(),
    idempotency_key: idempotencyKey,
    settlement_attempt_count: 1
  });

  if (settlementError && settlementError.code !== '23505') {
    console.error('[x402-inbound] Failed to insert x402_settlements:', settlementError.message);
  }

  // Write to repid_events for feedback loop worker
  await db.from('repid_events').insert({
    subject_id: agent.id,
    subject_type: 'agent',
    event_type: 'x402_inbound_settled',
    reputation_delta: 5,
    event_data: {
      tx_hash: txHash,
      payer: verifyResult.payer,
      amount: priceUsdc,
      topic: 'anfis_classification',
      settled_at: new Date().toISOString()
    }
  });

  if (includeHalCheck && halVerdict) {
    const { error: halErr } = await db.from('hal_evaluations').insert({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      mode: 'production',
      hal_mode: 'anfis_gateway',
      prompt_text_hash: promptHash.substring(0, 16),
      agent_id: agent.id,
      gen_provider: classification.provider,
      hal_signals: halVerdict.signals,
      hal_vetoed: halVerdict.status === 'BLOCK',
      decision: halVerdict.status,
      veto_class: halVerdict.veto_class,
      notes: halVerdict.notes,
      cost_usd: parseFloat(ethers.formatUnits(priceUsdc, 6))
    });
    
    if (halErr) {
      console.error('[x402-inbound] Failed to record hal_evaluations:', halErr.message);
    }
  }

  res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ status: 'settled', txHash }));
  const response: any = { ...classification };
  if (includeHalCheck) {
    response.hal_status = halVerdict.status;
  }
  if (signedReceipt) {
    response.signedReceipt = signedReceipt;
  }
  return res.status(200).json(response);
});

export default router;
