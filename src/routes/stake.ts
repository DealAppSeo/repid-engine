import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { fractionForRepID } from '../repid-staking/repid-fraction';
import { getStakingContractInfo, verifyStakeOnChain } from '../services/stake-onchain';
import { updateRepId } from '../engine/repid-update';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://qnnpjhlxljtqyigedwkb.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'dummy-key'
);

export const stakeRouter = Router();

const stakeLimiter = rateLimit({
  windowMs: 60 * 1000,

  max: 5,
  message: { error: 'Too many requests' }
});

stakeRouter.post('/stake/attempt-trade', stakeLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { user_id, agent_id, trade_size_usd } = req.body;
    if (!user_id || !agent_id || !trade_size_usd) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Read active stake for that user+agent
    const { data: stakes, error: stakeErr } = await supabase
      .from('repid_mvp_stakes')
      .select('id, stake_amount_usd')
      .eq('user_id', user_id)
      .eq('agent_id', agent_id)
      .eq('status', 'active');

    if (stakeErr || !stakes || stakes.length === 0) {
      res.status(400).json({ decision: 'rejected_no_stake', reason: `No active stakes backing ${agent_id}` });
      return;
    }
    const firstStake = stakes[0];
    if (!firstStake) {
      res.status(400).json({ decision: 'rejected_no_stake', reason: `No active stakes backing ${agent_id}` });
      return;
    }
    const totalBacking = stakes.reduce((sum: number, s: any) => sum + Number(s.stake_amount_usd), 0);
    const stake_id = firstStake.id;

    // Read agent repid
    const { data: agentData, error: agentErr } = await supabase
      .from('repid_mvp_agents')
      .select('repid_score')
      .eq('id', agent_id)
      .single();

    if (agentErr || !agentData) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const repidScore = agentData.repid_score;

    const fraction = fractionForRepID(repidScore);
    const maxAllowed = totalBacking * fraction;

    let decision = '';
    let reason = '';
    if (repidScore <= 0) {
      decision = 'rejected_repid_too_low';
      reason = `RepID ${repidScore} at-or-below floor`;
    } else if (trade_size_usd > maxAllowed) {
      decision = 'rejected_size';
      reason = `Trade size $${trade_size_usd} exceeds max allowed $${maxAllowed.toFixed(2)}`;
    } else {
      decision = 'approved';
      reason = `Trade size $${trade_size_usd} within max allowed $${maxAllowed.toFixed(2)}`;
    }

    const tradeAttempt = {
      user_id,
      agent_id,
      stake_id,
      trade_size_usd,
      repid_at_decision: repidScore,
      max_allowed_usd: maxAllowed,
      fraction_used: fraction,
      decision,
      reason,
      executed: decision === 'approved',
      executed_at: decision === 'approved' ? new Date().toISOString() : null,
      created_at: new Date().toISOString()
    };

    await supabase.from('repid_mvp_trade_attempts').insert([tradeAttempt]);

    res.json({
      decision,
      fraction_used: fraction,
      max_allowed_usd: maxAllowed,
      repid_at_decision: repidScore,
      reason
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

stakeRouter.get('/stake/recent', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('repid_mvp_trade_attempts')
    .select(`
      *,
      repid_mvp_users!inner(display_name),
      repid_mvp_agents!inner(display_name)
    `)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});

stakeRouter.get('/stake/seeded', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('repid_mvp_stakes')
    .select(`
      id,
      stake_amount_usd,
      status,
      repid_mvp_users!inner(id, display_name),
      repid_mvp_agents!inner(id, display_name, repid_score)
    `)
    .eq('status', 'active');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});

// ---------------------------------------------------------------------------
// ON-CHAIN STAKE PATH (canonical RepIDStaking contract, Base Sepolia).
// A client with testnet ETH stakes against the real contract; the verify
// endpoint confirms the on-chain Staked event and only then grants the +5.
// ---------------------------------------------------------------------------

// GET /api/v1/stake/onchain/info — where + how much to stake.
stakeRouter.get('/stake/onchain/info', async (_req: Request, res: Response): Promise<void> => {
  try {
    const info = await getStakingContractInfo();
    res.json({
      contract_address: info.contractAddress,
      min_stake_wei: info.minStakeWei,
      chain_id: info.chainId,
      network: info.network,
      deployed: info.contractAddress !== '',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/v1/stake/onchain/verify — { agent_id, tx_hash }.
// Verifies the on-chain Staked event; on success records the STAKE RepID
// delta with the tx_hash as provenance (this is the ONLY path that grants +5).
stakeRouter.post('/stake/onchain/verify', stakeLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { agent_id, tx_hash } = req.body ?? {};
    if (!agent_id || !tx_hash) {
      res.status(400).json({ error: 'agent_id and tx_hash required' });
      return;
    }

    const result = await verifyStakeOnChain(String(agent_id), String(tx_hash));
    if (!result.verified) {
      res.status(400).json({
        verified: false,
        reason: result.reason,
        tx_hash: result.txHash,
        basescan_url: result.basescanUrl,
      });
      return;
    }

    // Verified on-chain stake → grant the STAKE RepID delta, carrying the
    // tx_hash as provenance. updateRepId gates the delta on this proof (a
    // STAKE event without stakeProof yields delta 0 — no verified stake, no +5).
    let scoreResult: Awaited<ReturnType<typeof updateRepId>> | null = null;
    try {
      scoreResult = await updateRepId({
        agentId: String(agent_id),
        eventType: 'STAKE',
        stakeProof: {
          txHash: result.txHash,
          stakeId: result.stakeId ?? undefined,
          amountWei: result.amountWei ?? undefined,
          contractAddress: result.contractAddress ?? undefined,
          onChainAgentId: result.onChainAgentId ?? undefined,
          blockNumber: result.blockNumber ?? undefined,
        },
      });
    } catch (scoreErr: any) {
      // The stake IS verified on-chain even if scoring failed (e.g. agent row
      // absent). Report the verified stake honestly; surface the scoring error.
      res.status(200).json({
        verified: true,
        amount_wei: result.amountWei,
        stake_id: result.stakeId,
        contract_address: result.contractAddress,
        block_number: result.blockNumber,
        basescan_url: result.basescanUrl,
        repid_delta_applied: false,
        repid_error: scoreErr.message,
      });
      return;
    }

    res.json({
      verified: true,
      amount_wei: result.amountWei,
      stake_id: result.stakeId,
      on_chain_agent_id: result.onChainAgentId,
      contract_address: result.contractAddress,
      block_number: result.blockNumber,
      basescan_url: result.basescanUrl,
      repid_delta_applied: scoreResult.delta,
      repid_after: scoreResult.repIdAfter,
      tier: scoreResult.tier,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default stakeRouter;
