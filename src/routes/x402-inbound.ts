import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { trustedClientIp } from '../middleware/client-ip';
import {
  x402Facilitator,
  PaymentRequirements,
  SettlementResponseV2,
  paymentRequiredResponse,
  normalizePaymentHeader,
  acceptedMatches,
  encodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from '../services/x402-facilitator';
import { repIdAttestationService } from '../services/repid-attestation';
import { isPayableAddress } from '../services/payee-guard';
import { db } from '../db';

const router = Router();

/**
 * Per-route limiter for the paid route. Every /api/v1 request already passes the global token
 * bucket (src/middleware/rate-limit.ts, 60/min per IP, mounted earlier in src/index.ts); CodeQL's
 * js/missing-rate-limiting cannot see that one, and this also holds if it ever fails open.
 *
 * 120 per minute, not 60: a 60-token bucket refilling 60/min passes at most 120 requests in any
 * 60 s, so a fixed window of 120 never refuses a request the global limiter let through. Paying
 * clients are throttled no harder than before. `legacyHeaders: false` keeps it from overwriting
 * the global limiter's `X-RateLimit-*` headers; it reports in `RateLimit-*` instead.
 */
export const X402_ROUTE_LIMIT_PER_MIN = 120;
export const x402RouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: X402_ROUTE_LIMIT_PER_MIN,
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  // Bucket on the edge-set client IP, not the caller-writable X-Forwarded-For (same as index.ts).
  keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
  message: { error: 'rate_limited', bucket: 'x402-route', limit: X402_ROUTE_LIMIT_PER_MIN },
});

/**
 * Every 402 that advertises `accepts` carries the x402 v2 challenge twice: base64 in the
 * `PAYMENT-REQUIRED` header (the canonical v2 location, and what the official `@x402/*` client
 * reads) and as the JSON body (v2 top level, v1 fields kept on each entry for current clients).
 * Before 2026-11-16 there was no header, so a v2 client could not read the challenge at all.
 */
function sendPaymentRequired(
  res: Response,
  requirements: PaymentRequirements[],
  error: string,
  extraBody: Record<string, unknown> = {},
) {
  const challenge = paymentRequiredResponse(requirements, error, extraBody);
  res.setHeader(PAYMENT_REQUIRED_HEADER, challenge.header);
  return res.status(402).json(challenge.body);
}

/** v2 `PAYMENT-RESPONSE` (base64 SettlementResponse). The v1 `X-PAYMENT-RESPONSE` is set beside it, unchanged. */
function setPaymentResponse(res: Response, settlement: SettlementResponseV2) {
  res.setHeader(PAYMENT_RESPONSE_HEADER, encodeX402Header(settlement));
}

// SOPHIA trade analysis demo
router.post('/:uuid/trade-analysis', x402RouteLimiter, async (req: Request, res: Response) => {
  const { uuid } = req.params;
  // x402 v2 clients send PAYMENT-SIGNATURE; v1 clients and everything we ship send X-PAYMENT.
  // Two headers that disagree are refused (400, spec "Invalid Payment") rather than guessed between:
  // settling one while the client believes it sent the other is the failure to avoid.
  const paymentSignatureHeader = req.header(PAYMENT_SIGNATURE_HEADER);
  const legacyPaymentHeader = req.header('X-PAYMENT');
  if (paymentSignatureHeader && legacyPaymentHeader && paymentSignatureHeader !== legacyPaymentHeader) {
    return res.status(400).json({
      error: 'conflicting_payment_headers',
      message: 'PAYMENT-SIGNATURE and X-PAYMENT are both present and differ; send one.',
    });
  }
  const xPaymentHeader = paymentSignatureHeader || legacyPaymentHeader;

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

  // Fail closed: never advertise a 402 whose payee is the zero address. An agent
  // with no real payout wallet cannot be paid, so refuse rather than tell the
  // caller to sign an authorization to a burn.
  const payTo = agent.wallet_address;
  if (!isPayableAddress(payTo)) {
    return res.status(409).json({
      error: 'payee_unset',
      message: `agent ${agent.agent_name} has no payout wallet address; refusing to advertise payment to the zero address`,
    });
  }

  const requirements = x402Facilitator.buildPaymentRequirements({
    resource,
    payTo,
    priceUsdc,
    network: 'base-sepolia',
    description: `${agent.agent_name} trade analysis — verified by HyperDAG ZKP RepID`
  });

  // 2. Check for payment header
  if (!xPaymentHeader) {
    return sendPaymentRequired(res, requirements, 'Payment required');
  }

  // 2b. An official x402 PaymentPayload nests the signature and authorization under `payload`;
  //     the facilitator reads the flat shape our own clients send. Normalizing moves no value:
  //     amount, payee, asset and network in the facilitator request come from `requirements`.
  const payment = normalizePaymentHeader(xPaymentHeader);
  if (payment.shape === 'v2' && !acceptedMatches(payment.accepted, requirements)) {
    return sendPaymentRequired(res, requirements, 'Payment verification failed', {
      reason: 'accepted_requirements_mismatch: the payload accepted terms this server did not advertise',
    });
  }
  const paymentHeaderForFacilitator = payment.header;

  // 3. Verify payment via facilitator
  const verifyResult = await x402Facilitator.verifyPayment(paymentHeaderForFacilitator, requirements);
  if (!verifyResult.valid) {
    return sendPaymentRequired(res, requirements, 'Payment verification failed', {
      reason: verifyResult.reason,
    });
  }

  // 4. Extract and verify caller's attestation (if present)
  const callerAttestation = x402Facilitator.extractRepIdAttestation(req);
  if (callerAttestation) {
    const attestationResult = await repIdAttestationService.verifyAttestation(callerAttestation);
    if (!attestationResult.valid) {
      return sendPaymentRequired(res, requirements, 'invalid_attestation', {
        reason: attestationResult.reason,
      });
    }
  }

  const settledNetwork = requirements[0]?.network ?? '';

  // 5. Settle payment FIRST — a resource server must not deliver the service
  //    (nor claim it settled) unless the on-chain settlement actually
  //    succeeds. Per x402: on settlement failure return 402 (payment not
  //    completed), NOT 200 "settled" with an empty txHash.
  let txHash = '';
  try {
    const settleResult = await x402Facilitator.settlePayment(paymentHeaderForFacilitator, requirements);
    txHash = settleResult.txHash;
  } catch (e: any) {
    console.error('[x402-inbound] Settlement failed:', e.message);
    // Queue for out-of-band recovery, then tell the caller the truth: the
    // payment was NOT settled. Do not fall through to a 200 "settled".
    // The recovery worker re-settles from payment_payload_b64 through the same
    // facilitator decode, so it gets the normalized (flat) header.
    await x402Facilitator.queueFailure({
      direction: 'inbound',
      agent_id: agent.id,
      payment_payload_b64: paymentHeaderForFacilitator,
      payment_requirements: requirements,
      facilitator_response: { error: e.message }
    });
    res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ status: 'settlement_failed', txHash: '' }));
    setPaymentResponse(res, {
      success: false,
      errorReason: 'settlement_failed',
      transaction: '',
      network: settledNetwork,
      payer: verifyResult.payer,
    });
    return sendPaymentRequired(res, requirements, 'settlement_failed', { reason: e.message });
  }

  // Defensive: a facilitator that returns success but no tx hash is not a
  // real settlement — never emit "settled" with an empty txHash.
  if (!txHash) {
    res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ status: 'settlement_failed', txHash: '' }));
    setPaymentResponse(res, {
      success: false,
      errorReason: 'settlement_failed',
      transaction: '',
      network: settledNetwork,
      payer: verifyResult.payer,
    });
    return sendPaymentRequired(res, requirements, 'settlement_failed', {
      reason: 'facilitator returned no transaction hash',
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
  setPaymentResponse(res, { success: true, transaction: txHash, network: settledNetwork, payer: verifyResult.payer });
  res.setHeader('X-HYPERDAG-REPID-ATTESTATION', myAttestationB64);

  return res.status(200).json(analysis);
});

export default router;
