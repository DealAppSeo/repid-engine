import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { applyServiceFulfilledDeltas, applyServiceSatisfiedDeltas } from '../../services/validation-repid-delta';
import { x402Facilitator } from '../../services/x402-facilitator';
import { escrowRateLimitPerIP, escrowRateLimitPerApiKey } from '../../middleware/x402-rate-limit';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { service_id, buyer_agent_id, payload, agreed_price_usdc_raw } = req.body;
  if (!service_id || !buyer_agent_id || !payload) {
    return res.status(400).json({ error: 'service_id, buyer_agent_id, and payload required' });
  }

  // Get service
  const { data: service, error: sErr } = await db.from('agent_services').select('*').eq('id', service_id).maybeSingle();
  if (sErr || !service) return res.status(404).json({ error: 'Service not found' });
  if (!service.active) return res.status(400).json({ error: 'Service is not active' });

  // Get buyer repid
  const { data: buyer, error: bErr } = await db.from('repid_agents').select('current_repid').eq('id', buyer_agent_id).maybeSingle();
  if (bErr || !buyer) return res.status(404).json({ error: 'Buyer not found' });

  if (buyer.current_repid < (service.min_repid_to_purchase || 0)) {
    return res.status(403).json({ error: 'Buyer RepID below service minimum requirement' });
  }

  const price = agreed_price_usdc_raw !== undefined ? agreed_price_usdc_raw : service.base_price_usdc_raw;

  const { data, error } = await db.from('service_contracts').insert({
    service_id,
    buyer_agent_id,
    provider_agent_id: service.provider_agent_id,
    agreed_price_usdc_raw: price,
    payload,
    status: 'pending'
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.post('/:id/escrow', escrowRateLimitPerIP, escrowRateLimitPerApiKey, async (req: Request, res: Response) => {
  const contractId = req.params.id;

  // 1. Fetch contract
  const { data: contract, error: getErr } = await db.from('service_contracts')
    .select('*')
    .eq('id', contractId)
    .maybeSingle();

  if (getErr || !contract) {
    return res.status(404).json({ error: 'contract_not_found' });
  }

  // Toggle check
  const enforcementEnabled = process.env.X402_ENFORCEMENT_ENABLED === 'true';

  if (!enforcementEnabled) {
    // Legacy behavior
    const { data, error } = await db.from('service_contracts')
      .update({ status: 'escrowed', escrowed_at: new Date().toISOString() })
      .eq('id', contractId)
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  }

  // Idempotency check — if this contract already has a settlement, return existing
  const { data: existing, error: existErr } = await db.from('x402_settlements')
    .select('id')
    .eq('idempotency_key', contractId)
    .maybeSingle();

  if (existing) {
    const settlementId = existing.id;
    // ensure contract is escrowed with this settlement_id
    const { data: updatedContract, error: updateErr } = await db.from('service_contracts')
      .update({
        status: 'escrowed',
        x402_payment_id: settlementId,
        escrowed_at: new Date().toISOString()
      })
      .eq('id', contractId)
      .select().single();
    
    if (updateErr) {
      return res.status(500).json({ error: 'contract_update_failed', message: updateErr.message });
    }
    return res.json(updatedContract);
  }

  // Enforcement is ON: check contract status
  if (contract.status !== 'pending') {
    return res.status(409).json({ error: 'wrong_status', current: contract.status });
  }

  // 2. Fetch provider agent to get their wallet address
  const { data: provider, error: providerErr } = await db.from('repid_agents')
    .select('wallet_address')
    .eq('id', contract.provider_agent_id)
    .maybeSingle();

  const priceUsdc = String(contract.agreed_price_usdc_raw);
  const resource = `/api/v1/contracts/${contract.id}/escrow`;

  const requirements = x402Facilitator.buildPaymentRequirements({
    resource,
    payTo: provider?.wallet_address || '0x0000000000000000000000000000000000000000',
    priceUsdc,
    network: 'base-sepolia',
    description: `Service Contract ${contract.id} Escrow payment`
  });

  // 3. Parse X-PAYMENT header
  const xPaymentHeader = req.header('X-PAYMENT');
  if (!xPaymentHeader) {
    return res.status(402).json({
      x402Version: 1,
      accepts: requirements,
      error: 'Payment required'
    });
  }

  // 4. Verify payment via facilitator
  const isSimulated = !process.env.X402_REAL_RPC;
  let txHash = '';
  let payerAddress = '';

  if (!isSimulated) {
    const verifyResult = await x402Facilitator.verifyPayment(xPaymentHeader, requirements);
    if (!verifyResult.valid) {
      return res.status(402).json({
        x402Version: 1,
        accepts: requirements,
        error: 'Payment verification failed',
        reason: verifyResult.reason
      });
    }
    payerAddress = verifyResult.payer;
  }

  if (!isSimulated) {
    try {
      const settleResult = await x402Facilitator.settlePayment(xPaymentHeader, requirements);
      txHash = settleResult.txHash;
    } catch (e: any) {
      console.error('[escrow-x402] Settlement failed, queuing for recovery:', e.message);
      await x402Facilitator.queueFailure({
        direction: 'inbound',
        agent_id: contract.buyer_agent_id,
        payment_payload_b64: xPaymentHeader,
        payment_requirements: requirements,
        facilitator_response: { error: e.message }
      });
      return res.status(500).json({ error: 'settlement_failed', message: e.message });
    }
  } else {
    // Simulated mode: accept header as-is
    txHash = xPaymentHeader; // Use header as mock tx_hash
  }

  // 5. Record settlement in x402_settlements
  const topic = String((contract.payload as any)?.service_type || 'service_escrow');
  const { data: settlement, error: settleInsertErr } = await db.from('x402_settlements').insert({
    tip_id: `contract_${contractId}`,
    prediction_topic: topic,
    amount: Number(contract.agreed_price_usdc_raw),
    asset: 'USDC',
    status: 'settled',
    payer_address: payerAddress || null,
    provider_agent_id: contract.provider_agent_id,
    requestor_agent_id: contract.buyer_agent_id,
    x_payment_header: xPaymentHeader,
    is_simulated: isSimulated,
    delivered_at: new Date().toISOString(),
    idempotency_key: contractId,
    settlement_attempt_count: 1
  }).select('id').single();

  if (settleInsertErr) {
    console.error('[escrow-x402] Failed to insert x402_settlement:', settleInsertErr.message);
    return res.status(500).json({ error: 'database_insert_failed', message: settleInsertErr.message });
  }

  // 6. Update contract: transition status to escrowed and link x402_payment_id
  const { data: updatedContract, error: updateErr } = await db.from('service_contracts')
    .update({
      status: 'escrowed',
      x402_payment_id: settlement.id,
      escrowed_at: new Date().toISOString()
    })
    .eq('id', contractId)
    .select().single();

  if (updateErr) {
    console.error('[escrow-x402] Failed to update service contract:', updateErr.message);
    return res.status(500).json({ error: 'contract_update_failed', message: updateErr.message });
  }

  res.json(updatedContract);
});


router.post('/:id/cancel', async (req: Request, res: Response) => {
  const { data, error } = await db.from('service_contracts')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .select().single();
  
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.post('/:id/fulfill', async (req: Request, res: Response) => {
  const { result } = req.body;
  if (!result) return res.status(400).json({ error: 'result required' });

  const { data, error } = await db.from('service_contracts')
    .update({ status: 'fulfilled', result, fulfilled_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  
  if (error) return res.status(400).json({ error: error.message });

  // Apply RepID deltas for fulfillment
  if (data) {
    try {
      await applyServiceFulfilledDeltas(data);
    } catch (e) {
      console.error('Failed to apply fulfilled deltas:', e);
    }
  }

  res.json(data);
});

router.post('/:id/satisfy', async (req: Request, res: Response) => {
  const { satisfaction_score } = req.body;
  if (satisfaction_score === undefined) return res.status(400).json({ error: 'satisfaction_score required' });

  // Two-step update to honor trigger logic ('satisfied' then 'settled')
  const { data: step1, error: err1 } = await db.from('service_contracts')
    .update({ status: 'satisfied', buyer_satisfaction_score: satisfaction_score, satisfied_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  
  if (err1) return res.status(400).json({ error: err1.message });

  const { data: step2, error: err2 } = await db.from('service_contracts')
    .update({ status: 'settled', settled_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
    
  if (err2) return res.status(400).json({ error: err2.message });

  // Apply RepID deltas for satisfaction
  if (step2) {
    try {
      await applyServiceSatisfiedDeltas(step2, satisfaction_score);
    } catch (e) {
      console.error('Failed to apply satisfied deltas:', e);
    }
  }

  res.json(step2);
});

router.post('/:id/dispute', async (req: Request, res: Response) => {
  const { reason, evidence } = req.body;
  
  const { data: contract, error: getErr } = await db.from('service_contracts').select('*').eq('id', req.params.id).single();
  if (getErr || !contract) return res.status(404).json({ error: 'Contract not found' });

  const { data, error } = await db.from('service_contracts')
    .update({ status: 'disputed', disputed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  
  if (error) return res.status(400).json({ error: error.message });

  // Insert into dispute_validation_queue
  const { data: disputeRow, error: dispErr } = await db.from('dispute_validation_queue').insert({
    contract_id: contract.id,
    metadata: { reason, evidence }
  }).select('id').single();

  if (dispErr) {
    console.error('Failed to enqueue dispute:', dispErr);
  } else if (disputeRow) {
    await db.from('service_contracts').update({ dispute_panel_validation_queue_id: disputeRow.id }).eq('id', contract.id);
  }

  res.json(data);
});

router.post('/:id/resolve', async (req: Request, res: Response) => {
  const { dispute_verdict } = req.body;
  if (!dispute_verdict) return res.status(400).json({ error: 'dispute_verdict required' });

  const { data, error } = await db.from('service_contracts')
    .update({ status: 'resolved', dispute_verdict, resolved_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await db.from('service_contracts').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Contract not found' });
  res.json(data);
});

router.get('/', async (req: Request, res: Response) => {
  const { buyer, provider, status, limit, offset } = req.query;
  
  let query = db.from('service_contracts').select('*', { count: 'exact' });
  
  if (buyer) query = query.eq('buyer_agent_id', buyer);
  if (provider) query = query.eq('provider_agent_id', provider);
  if (status) query = query.eq('status', status);
  
  const l = Number(limit) || 50;
  const o = Number(offset) || 0;
  query = query.range(o, o + l - 1).limit(Math.min(l, 200));

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  
  res.json({ data, count, limit: l, offset: o });
});

export default router;
