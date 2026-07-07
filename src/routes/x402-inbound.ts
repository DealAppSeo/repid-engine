import { Router, Request, Response } from 'express';
import { x402Facilitator, X402_VERSION } from '../services/x402-facilitator';
import { repIdAttestationService } from '../services/repid-attestation';
import { db } from '../db';

const router = Router();

// SOPHIA trade analysis demo
router.post('/:uuid/trade-analysis', async (req: Request, res: Response) => {
  const { uuid } = req.params;
  const xPaymentHeader = req.header('X-PAYMENT');

  // 1. Fetch agent (e.g. SOPHIA) to get wallet address
  // Use maybeSingle() to handle non-UUID strings gracefully (though auth-bypass check might already filter)
  const { data: agent, error: agentError } = await db
    .from('repid_agents')
    .select('id, agent_name, wallet_address, current_repid, tier')
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
      x402Version: X402_VERSION,
      accepts: requirements,
      error: 'Payment required'
    });
  }

  // 3. Verify payment via facilitator
  const verifyResult = await x402Facilitator.verifyPayment(xPaymentHeader, requirements);
  if (!verifyResult.valid) {
    return res.status(402).json({
      x402Version: X402_VERSION,
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
        x402Version: X402_VERSION,
        accepts: requirements,
        error: 'invalid_attestation',
        reason: attestationResult.reason
      });
    }
  }

  // 5. Settle payment FIRST — a resource server must not deliver the service
  //    (nor claim it settled) unless the on-chain settlement actually
  //    succeeds. Per x402: on settlement failure return 402 (payment not
  //    completed), NOT 200 "settled" with an empty txHash.
  let txHash = '';
  try {
    const settleResult = await x402Facilitator.settlePayment(xPaymentHeader, requirements);
    txHash = settleResult.txHash;
  } catch (e: any) {
    console.error('[x402-inbound] Settlement failed:', e.message);
    // Queue for out-of-band recovery, then tell the caller the truth: the
    // payment was NOT settled. Do not fall through to a 200 "settled".
    await x402Facilitator.queueFailure({
      direction: 'inbound',
      agent_id: agent.id,
      payment_payload_b64: xPaymentHeader,
      payment_requirements: requirements,
      facilitator_response: { error: e.message }
    });
    res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ status: 'settlement_failed', txHash: '' }));
    return res.status(402).json({
      x402Version: X402_VERSION,
      accepts: requirements,
      error: 'settlement_failed',
      reason: e.message
    });
  }

  // Defensive: a facilitator that returns success but no tx hash is not a
  // real settlement — never emit "settled" with an empty txHash.
  if (!txHash) {
    res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ status: 'settlement_failed', txHash: '' }));
    return res.status(402).json({
      x402Version: X402_VERSION,
      accepts: requirements,
      error: 'settlement_failed',
      reason: 'facilitator returned no transaction hash'
    });
  }

  // 6. Deliver service — settlement confirmed above.
  //    HONESTY (RULE-4): there is no real trade-analysis engine wired here
  //    yet. Never return a fabricated verdict (e.g. a hardcoded "Bullish")
  //    with is_verified_by_hyperdag:true to a paying caller. A canned demo
  //    string is only emitted when X402_DEMO_ANALYSIS=true (default OFF), and
  //    it is explicitly labelled is_demo:true / is_verified_by_hyperdag:false
  //    so no caller mistakes it for a real signal.
  const demoEnabled = process.env.X402_DEMO_ANALYSIS === 'true';
  const analysis = demoEnabled
    ? {
        agent: agent.agent_name,
        timestamp: new Date().toISOString(),
        status: 'demo',
        is_demo: true,
        analysis: `DEMO ONLY (X402_DEMO_ANALYSIS=on) — not a real market signal. Sample output for ${agent.agent_name}. RepID leverage factor: ${(agent.current_repid / 1000).toFixed(2)}x.`,
        is_verified_by_hyperdag: false,
      }
    : {
        agent: agent.agent_name,
        timestamp: new Date().toISOString(),
        status: 'not_implemented',
        error: 'trade_analysis_not_available',
        message:
          'Trade analysis is not yet implemented on this endpoint. Payment settlement below is real; no verified signal is produced.',
        is_verified_by_hyperdag: false,
      };

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

  return res.status(200).json(analysis);
});

export default router;
