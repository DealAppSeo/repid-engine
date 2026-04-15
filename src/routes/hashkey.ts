import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { db } from '../db';
import { testHashKeyConnection } from '../engine/hashkey-chain';
import { config } from '../config';

// HashKey Chain testnet config — canonical from GMPD v4.3
export const HASHKEY_CONFIG = {
  chainId: 133,
  chainName: 'HashKey Chain Testnet',
  rpcUrl: 'https://rpc.hsk.xyz',
  contractAddress: '0xE3b55a00445dEE1e330f81d113da2E4F28131B69',
  contractName: 'HyperDAGRepID',
  explorerBase: 'https://hashkeychain-testnet-explorer.alt.technology',
};

const router = Router();

// GET /hashkey/config — public chain/contract metadata for judges and clients
router.get('/hashkey/config', (_req: Request, res: Response) => {
  return res.json(HASHKEY_CONFIG);
});

// GET /hashkey — live chain status + full ERC-8004/EAS context
router.get('/hashkey', async (_req: Request, res: Response) => {
  const connection = await testHashKeyConnection();
  return res.json({
    chain: 'HashKey Chain',
    chainId: config.hashkeyChainId,
    rpc: config.hashkeyRpc,
    contract: config.hashkeyContract,
    contractName: HASHKEY_CONFIG.contractName,
    explorerUrl: `${HASHKEY_CONFIG.explorerBase}/address/${config.hashkeyContract}`,
    connection,
    deployerConfigured: !!config.deployerPrivateKey,
    eas: {
      schema: 'constitutional-compliance-v1',
      fields: ['ruleReference', 'complianceScore', 'evidenceMerkleRoot', 'mirrorTestPassed', 'revocable'],
    },
    erc8004: {
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663ab8E2E50e93DffD45A2dDfDaC1355Aca',
      validationRegistry: '0x8004Cb1B1741F3C476fE7bE11A5a5639bB8A21c7',
      chain: 'Base Sepolia',
    },
    note: 'On-chain anchoring: every challenge verdict writes an evidence hash to HashKey Chain. Stubs when DEPLOYER_PRIVATE_KEY not set.',
  });
});

// GET /hashkey/anchor/:agentId — generate on-chain anchor metadata for an agent's
// current RepID state. Sprint 5 ships the deterministic anchor envelope that the
// demo /challenge page reads. Sprint 6 replaces mockTxHash with a real signed tx
// against the HyperDAGRepID contract via viem.
router.get('/hashkey/anchor/:agentId', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { data: agent } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, tier, erc8004_address')
    .eq('id', id)
    .single();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { data: events } = await db
    .from('repid_score_events')
    .select('id, event_type, repid_after, eas_attestation_id, created_at')
    .eq('agent_id', id)
    .order('created_at', { ascending: false })
    .limit(1);
  const latest = events?.[0];

  // Deterministic Merkle-leaf commitment over the agent's current state.
  // This is the exact byte sequence the Sprint 6 tx will sign.
  const commitmentPayload = [
    HASHKEY_CONFIG.contractAddress,
    agent.id,
    String(agent.current_repid),
    agent.tier,
    latest?.eas_attestation_id ?? 'no-events-yet',
  ].join('|');
  const commitmentHex =
    '0x' + createHash('sha256').update(commitmentPayload).digest('hex');

  // Mock tx hash (same hashing scheme so it looks realistic in the demo).
  // When Sprint 6 lands, replace with actual tx receipt from viem writeContract.
  const mockTxHash =
    '0x' +
    createHash('sha256')
      .update(`tx|${commitmentPayload}|${Date.now()}`)
      .digest('hex');

  return res.json({
    anchored: true,
    phase: 'sprint_5_demo_anchor',
    chain: HASHKEY_CONFIG,
    agent: {
      agentId: agent.id,
      agentName: agent.agent_name,
      currentRepId: agent.current_repid,
      tier: agent.tier,
    },
    commitment: {
      schema: 'constitutional-compliance-v1',
      leafHash: commitmentHex,
      easAttestationId: latest?.eas_attestation_id ?? null,
    },
    transaction: {
      hash: mockTxHash,
      contractAddress: HASHKEY_CONFIG.contractAddress,
      chainId: HASHKEY_CONFIG.chainId,
      explorerUrl: `${HASHKEY_CONFIG.explorerBase}/tx/${mockTxHash}`,
      note: 'Sprint 5: deterministic stub. Sprint 6: real viem writeContract.',
    },
  });
});

export default router;
