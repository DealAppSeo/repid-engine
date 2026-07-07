import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { applyServiceFulfilledDeltas, applyServiceSatisfiedDeltas } from '../../services/validation-repid-delta';
import { x402Facilitator, X402_VERSION } from '../../services/x402-facilitator';
import { x402Metrics } from '../../observability/x402-metrics';
import { getActiveNetwork } from '../../config/network';
import { todayPT } from '../../lib/time';

const router = Router();

function checkGlobalValueCaps(priceUsdcRaw: number, settledTodayRaw: number): { allowed: boolean; error?: string; cap?: number; requested?: number } {
  const enforcement = process.env.VALUE_CAP_ENFORCEMENT || 'enforce';
  const perContractCapRaw = (Number(process.env.VALUE_CAP_PER_CONTRACT_USDC) || 10) * 1_000_000;
  const dailyCapRaw = (Number(process.env.VALUE_CAP_DAILY_USDC) || 100) * 1_000_000;

  console.log('DEBUG GLOBAL CAPS:', {
    priceUsdcRaw,
    settledTodayRaw,
    enforcement,
    perContractCapRaw,
    dailyCapRaw,
    envPerContract: process.env.VALUE_CAP_PER_CONTRACT_USDC,
    envDaily: process.env.VALUE_CAP_DAILY_USDC
  });

  if (enforcement === 'off') {
    return { allowed: true };
  }

  if (priceUsdcRaw > perContractCapRaw) {
    if (enforcement === 'warn') {
      console.warn(`[VALUE_CAP_WARNING] Per-contract cap exceeded. Limit: ${perContractCapRaw}, Requested: ${priceUsdcRaw}`);
      return { allowed: true };
    }
    return {
      allowed: false,
      error: 'per_contract_cap_exceeded',
      cap: perContractCapRaw,
      requested: priceUsdcRaw
    };
  }

  if (settledTodayRaw + priceUsdcRaw > dailyCapRaw) {
    if (enforcement === 'warn') {
      console.warn(`[VALUE_CAP_WARNING] Daily cumulative cap exceeded. Limit: ${dailyCapRaw}, Requested: ${settledTodayRaw + priceUsdcRaw}`);
      return { allowed: true };
    }
    return {
      allowed: false,
      error: 'daily_cumulative_cap_exceeded',
      cap: dailyCapRaw,
      requested: settledTodayRaw + priceUsdcRaw
    };
  }

  return { allowed: true };
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const { service_id, buyer_agent_id, payload, agreed_price_usdc_raw } = req.body;
    if (!service_id || !buyer_agent_id || !payload) {
      return res.status(400).json({ error: 'service_id, buyer_agent_id, and payload required' });
    }

    // Get service
    const { data: service, error: sErr } = await db.from('agent_services').select('*').eq('id', service_id).maybeSingle();
    if (sErr || !service) return res.status(404).json({ error: 'Service not found' });
    if (!service.active) return res.status(400).json({ error: 'Service is not active' });

    // Self-dealing guard (H3)
    if (buyer_agent_id === service.provider_agent_id) {
      return res.status(400).json({ error: 'self_dealing_forbidden', message: 'Self-dealing is forbidden' });
    }

    // Get buyer repid
    const { data: buyer, error: bErr } = await db.from('repid_agents').select('current_repid').eq('id', buyer_agent_id).maybeSingle();
    if (bErr || !buyer) return res.status(404).json({ error: 'Buyer not found' });

    if (buyer.current_repid < (service.min_repid_to_purchase || 0)) {
      return res.status(403).json({ error: 'Buyer RepID below service minimum requirement' });
    }

    const price = agreed_price_usdc_raw !== undefined ? agreed_price_usdc_raw : service.base_price_usdc_raw;

    // Global Value Caps Check
    const today = todayPT();
    const { data: settledToday, error: volErr } = await db
      .from('x402_settlements')
      .select('amount')
      .eq('status', 'settled')
      .gte('created_at', `${today}T00:00:00.000Z`)
      .lte('created_at', `${today}T23:59:59.999Z`);
    const settledTodayRaw = (settledToday || []).reduce((acc, row) => acc + Number(row.amount || 0), 0);

    const capCheck = checkGlobalValueCaps(Number(price), settledTodayRaw);
    if (!capCheck.allowed) {
      return res.status(402).json({
        error: capCheck.error,
        message: `Value cap exceeded: ${capCheck.error}`,
        cap: capCheck.cap,
        requested: capCheck.requested
      });
    }

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
  } catch (err: any) {
    console.error('ERROR IN POST /:', err);
    res.status(500).json({ error: 'internal_error', message: err.message, stack: err.stack });
  }
});

router.post('/:id/escrow', async (req: Request, res: Response) => {
  try {
    const contractId = req.params.id;
  x402Metrics.increment('escrow.attempt');

  // 1. Fetch contract
  const { data: contract, error: getErr } = await db.from('service_contracts')
    .select('*')
    .eq('id', contractId)
    .maybeSingle();

  if (getErr || !contract) {
    x402Metrics.increment('escrow.error.400');
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
    if (error) {
      x402Metrics.increment('escrow.error.400');
      return res.status(400).json({ error: error.message });
    }
    x402Metrics.increment('escrow.success');
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
      x402Metrics.increment('escrow.error.500');
      return res.status(500).json({ error: 'contract_update_failed', message: updateErr.message });
    }
    x402Metrics.increment('escrow.success');
    return res.json(updatedContract);
  }

  // Enforcement is ON: check contract status
  if (contract.status !== 'pending') {
    x402Metrics.increment('escrow.error.400');
    return res.status(409).json({ error: 'wrong_status', current: contract.status });
  }

  // Global Value Caps Check
  const today = new Date().toISOString().split('T')[0];
  const { data: settledToday, error: volErr } = await db
    .from('x402_settlements')
    .select('amount')
    .eq('status', 'settled')
    .gte('created_at', `${today}T00:00:00.000Z`)
    .lte('created_at', `${today}T23:59:59.999Z`);
  const settledTodayRaw = (settledToday || []).reduce((acc, row) => acc + Number(row.amount || 0), 0);

  const capCheck = checkGlobalValueCaps(Number(contract.agreed_price_usdc_raw), settledTodayRaw);
  if (!capCheck.allowed) {
    x402Metrics.increment('escrow.error.402');
    return res.status(402).json({
      error: capCheck.error,
      message: `Value cap exceeded: ${capCheck.error}`,
      cap: capCheck.cap,
      requested: capCheck.requested
    });
  }

  // 1.5. Enforce Mainnet Safety Caps if applicable
  const activeNetwork = getActiveNetwork();
  console.log('DEBUG ACTIVE NETWORK:', activeNetwork.name, 'CAPS:', JSON.stringify(activeNetwork.caps));
  const rawPrice = Number(contract.agreed_price_usdc_raw);
  const priceInUsd = rawPrice / 1_000_000;

  if (activeNetwork.caps) {
    const { perContractUsdCap, dailyVolumeUsdCap, perAgentDailyTxCap } = activeNetwork.caps;

    // Per-contract Cap Check
    if (perContractUsdCap && priceInUsd > perContractUsdCap) {
      x402Metrics.increment('escrow.error.402');
      return res.status(402).json({
        error: 'per_contract_cap_exceeded',
        message: 'Value cap exceeded: per_contract_cap_exceeded',
        cap: perContractUsdCap * 1_000_000,
        requested: rawPrice,
      });
    }

    const today = todayPT();

    // Daily Volume Cap Check
    if (dailyVolumeUsdCap) {
      const { data: settledToday, error: volErr } = await db
        .from('x402_settlements')
        .select('amount')
        .eq('is_simulated', false)
        .eq('status', 'settled')
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lte('created_at', `${today}T23:59:59.999Z`);

      if (volErr) {
        console.error('[escrow-x402] Failed to check daily settled volume:', volErr.message);
      } else {
        const todayVolumeUsd = (settledToday || []).reduce((acc, row) => acc + Number(row.amount), 0) / 1_000_000;
        if (todayVolumeUsd + priceInUsd > dailyVolumeUsdCap) {
          x402Metrics.increment('escrow.error.402');
          return res.status(402).json({
            error: 'daily_cumulative_cap_exceeded',
            message: 'Value cap exceeded: daily_cumulative_cap_exceeded',
            cap: dailyVolumeUsdCap * 1_000_000,
            requested: (todayVolumeUsd + priceInUsd) * 1_000_000,
          });
        }
      }
    }

    // Per-agent Daily Transaction Cap Check
    if (perAgentDailyTxCap) {
      const { count: agentTxToday, error: countErr } = await db
        .from('x402_settlements')
        .select('*', { count: 'exact', head: true })
        .eq('is_simulated', false)
        .eq('requestor_agent_id', contract.buyer_agent_id)
        .eq('status', 'settled')
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lte('created_at', `${today}T23:59:59.999Z`);

      if (countErr) {
        console.error('[escrow-x402] Failed to check per-agent daily transaction count:', countErr.message);
      } else if (agentTxToday !== null && agentTxToday >= perAgentDailyTxCap) {
        x402Metrics.increment('escrow.error.429');
        return res.status(429).json({
          error: 'per_agent_daily_tx_cap_exceeded',
          cap: perAgentDailyTxCap,
          todays_count: agentTxToday,
        });
      }
    }
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
    description: `Service Contract ${contract.id} Escrow payment`
  });

  // 3. Parse X-PAYMENT header
  const xPaymentHeader = req.header('X-PAYMENT');
  if (!xPaymentHeader) {
    x402Metrics.increment('escrow.error.402');
    return res.status(402).json({
      x402Version: X402_VERSION,
      accepts: requirements,
      error: 'Payment required'
    });
  }

  // Replay protection (H1): verify this payment header hasn't been settled yet
  const { data: duplicatePayment, error: dupErr } = await db.from('x402_settlements')
    .select('id')
    .eq('x_payment_header', xPaymentHeader)
    .maybeSingle();

  if (dupErr) {
    x402Metrics.increment('escrow.error.500');
    return res.status(500).json({ error: 'database_query_failed', message: dupErr.message });
  }
  if (duplicatePayment) {
    x402Metrics.increment('escrow.error.400');
    return res.status(400).json({ error: 'payment_already_used', message: 'This payment header has already been settled.' });
  }

  // 4. Verify payment via facilitator
  const isSimulated = !process.env.X402_REAL_RPC;
  let txHash = '';
  let payerAddress = '';

  if (!isSimulated) {
    const verifyResult = await x402Facilitator.verifyPayment(xPaymentHeader, requirements);
    if (!verifyResult.valid) {
      x402Metrics.increment('escrow.error.402');
      return res.status(402).json({
        x402Version: X402_VERSION,
        accepts: requirements,
        error: 'Payment verification failed',
        reason: verifyResult.reason
      });
    }
    payerAddress = verifyResult.payer;
  } else {
    // Simulated mode verify instrumentation
    x402Metrics.increment('facilitator.verify.attempt');
    x402Metrics.increment('facilitator.verify.simulated');
    x402Metrics.increment('facilitator.verify.success');
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
      x402Metrics.increment('escrow.error.500');
      return res.status(500).json({ error: 'settlement_failed', message: e.message });
    }
  } else {
    // Simulated mode: accept header as-is
    txHash = xPaymentHeader; // Use header as mock tx_hash
    x402Metrics.increment('facilitator.settle.attempt');
    x402Metrics.increment('facilitator.settle.simulated');
    x402Metrics.increment('facilitator.settle.success');
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
    settlement_attempt_count: 1,
    tx_hash: txHash
  }).select('id').single();

  if (settleInsertErr) {
    // H2 ergonomics: if unique constraint violation (duplicate idempotency key), re-select the existing settlement
    if (settleInsertErr.code === '23505' || settleInsertErr.message?.includes('duplicate key') || settleInsertErr.message?.includes('unique constraint')) {
      const { data: existingSettle, error: getSettleErr } = await db.from('x402_settlements')
        .select('id')
        .eq('idempotency_key', contractId)
        .maybeSingle();

      if (!getSettleErr && existingSettle) {
        // If we found the existing settlement, update the contract to link it
        const { data: updatedContract, error: updateErr } = await db.from('service_contracts')
          .update({
            status: 'escrowed',
            x402_payment_id: existingSettle.id,
            escrowed_at: new Date().toISOString()
          })
          .eq('id', contractId)
          .select().single();

        if (!updateErr && updatedContract) {
          x402Metrics.increment('escrow.success');
          return res.json(updatedContract);
        }
      }
    }

    console.error('[escrow-x402] Failed to insert x402_settlement:', settleInsertErr.message);
    x402Metrics.increment('escrow.error.500');
    return res.status(500).json({ error: 'database_insert_failed', message: settleInsertErr.message });
  }

  // 6. Update contract: transition status to escrowed and link x402_payment_id
  const { data: updatedContract, error: updateErr } = await db.from('service_contracts')
    .update({
      status: 'escrowed',
      x402_payment_id: settlement.id,
      escrowed_at: new Date().toISOString(),
      settled_at: new Date().toISOString()
    })
    .eq('id', contractId)
    .select().single();

  if (updateErr) {
    console.error('[escrow-x402] Failed to update service contract:', updateErr.message);
    x402Metrics.increment('escrow.error.500');
    return res.status(500).json({ error: 'contract_update_failed', message: updateErr.message });
  }

    x402Metrics.increment('escrow.success');
    res.json(updatedContract);
  } catch (err: any) {
    console.error('ERROR IN ESCROW:', err);
    res.status(500).json({ error: 'internal_error', message: err.message, stack: err.stack });
  }
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

  // 1. Fetch the existing contract to verify status precondition
  const { data: existingContract, error: getErr } = await db.from('service_contracts')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (getErr || !existingContract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  // 2. Idempotent check: if already fulfilled, skip deltas and return 200 OK with the existing contract data
  if (existingContract.status === 'fulfilled') {
    return res.json(existingContract);
  }

  // 3. Precondition check: only escrowed contracts can be fulfilled
  if (existingContract.status !== 'escrowed') {
    return res.status(400).json({ error: `Cannot fulfill contract in status: ${existingContract.status}` });
  }

  // 4. Atomic state machine guard: update only if status is still escrowed (race prevention)
  const { data, error } = await db.from('service_contracts')
    .update({ status: 'fulfilled', result, fulfilled_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('status', 'escrowed')
    .select().single();
  
  if (error) {
    // If update failed due to no rows matching, double check if it was fulfilled by a concurrent request
    if (error.code === 'PGRST116') {
      const { data: doubleCheck, error: doubleCheckErr } = await db.from('service_contracts')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (!doubleCheckErr && doubleCheck && doubleCheck.status === 'fulfilled') {
        return res.json(doubleCheck);
      }
    }
    return res.status(400).json({ error: error.message });
  }

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
