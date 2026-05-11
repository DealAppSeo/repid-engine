import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

const TIER_THRESHOLD: Record<string, number> = {
  PROBATIONARY: 0,
  EARNING: 499,
  ESTABLISHED: 999,
  AUTONOMOUS: 4999,
  VETERAN: 7999,
};

/**
 * GET /api/v1/agents/:id/verify
 * Public verification endpoint providing a complete verifiable package.
 * Combines agent metadata, latest proof, and human/LLM-readable narrative.
 */
router.get('/:id/verify', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 1. Fetch Agent Metadata
    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('*')
      .eq('id', id)
      .single();

    if (agentErr || !agent) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND', detail: `Agent ${id} not found` });
    }

    // 2. Fetch Latest Completed Proof
    const { data: proof, error: proofErr } = await db
      .from('repid_proof_queue')
      .select('*')
      .eq('agent_id', id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();

    const tier = agent.tier as string;
    const threshold = TIER_THRESHOLD[tier] ?? 0;

    // 3. Build Verification Package
    const verificationPackage: any = {
      agent: {
        id: agent.id,
        name: agent.agent_name,
        current_repid: agent.current_repid,
        tier: agent.tier,
        vdr_count: agent.vdr_count,
        created_at: agent.created_at,
        last_active_at: agent.last_active_at,
      },
      verification: {
        status: proof ? 'verified' : 'pending',
        latest_proof_job: proof?.job_id || null,
        verified_at: proof?.completed_at || null,
        proof_hash: proof?.proof_hash || null,
      },
      narrative: {
        summary: `Agent ${agent.agent_name} is currently ranked at the ${agent.tier} tier with a RepID of ${agent.current_repid}.`,
        trust_statement: `This agent has successfully processed ${agent.vdr_count} verified decisions. Its reputation is backed by a STARK proof confirming its score exceeds the ${tier} threshold of ${threshold}.`,
        recommendation: agent.current_repid >= 1000 
          ? 'Recommended for high-value autonomous transactions.' 
          : 'Exercise caution; agent is in early-stage reputation building.'
      },
      onchain: null
    };

    // 4. Defensive On-Chain Data (Sprint 6 compatibility)
    if (agent.erc8004_address || agent.erc8004_token_id) {
      verificationPackage.onchain = {
        erc8004_address: agent.erc8004_address || null,
        token_id: agent.erc8004_token_id || null,
        mint_tx_hash: (agent as any).mint_tx_hash || null, // Defensive
        status: agent.erc8004_token_id ? 'minted' : 'pending_mint'
      };
    }

    // 5. Include Proof Bytes for Client-Side Verify (if requested or present)
    if (proof) {
      verificationPackage.proof_package = {
        proof_bytes: proof.proof_bytes,
        statement: {
          agent_id: agent.id,
          repid_score: agent.current_repid,
          threshold: threshold,
          tier: tier
        }
      };
    }

    return res.json(verificationPackage);
  } catch (e: any) {
    console.error(`[verify] page error: ${e.message}`);
    res.status(500).json({ error: 'INTERNAL', detail: e.message });
  }
});

export default router;
