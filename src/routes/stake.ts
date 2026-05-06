import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { fractionForRepID } from '../repid-staking/repid-fraction';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://qnnpjhlxljtqyigedwkb.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
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

export default stakeRouter;
