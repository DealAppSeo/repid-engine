import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { db } from '../db';
import { testHashKeyConnection } from '../engine/hashkey-chain';
import { config } from '../config';

// HashKey Chain testnet config — canonical from GMPD v4.3
export const HASHKEY_CONFIG = {
  chainId: 133,
  chainName: 'HashKey Chain Testnet',
  rpcUrl: 'https://testnet.hsk.xyz',
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
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
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
  const id = String(req.params.agentId);
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
  // This is a real, verifiable local hash — the exact byte sequence a future
  // on-chain tx would sign. It is NOT a transaction and is NOT anchored.
  const commitmentPayload = [
    HASHKEY_CONFIG.contractAddress,
    agent.id,
    String(agent.current_repid),
    agent.tier,
    latest?.eas_attestation_id ?? 'no-events-yet',
  ].join('|');
  const commitmentHex =
    '0x' + createHash('sha256').update(commitmentPayload).digest('hex');

  // HONESTY (RULE-4): the on-chain write is NOT implemented. Never fabricate a
  // tx hash or explorer URL. Report the true state: the commitment leaf is
  // computed, but nothing has been anchored on HashKey Chain yet.
  // A simulated tx is only produced when MOCK_HASHKEY_ANCHOR=true (default OFF),
  // and it is clearly labelled is_simulated so no caller mistakes it for real.
  const mockEnabled = process.env.MOCK_HASHKEY_ANCHOR === 'true';
  const simulatedTx = mockEnabled
    ? {
        is_simulated: true,
        hash:
          '0x' +
          createHash('sha256')
            .update(`sim-tx|${commitmentPayload}|${Date.now()}`)
            .digest('hex'),
        contractAddress: HASHKEY_CONFIG.contractAddress,
        chainId: HASHKEY_CONFIG.chainId,
        note: 'SIMULATED — MOCK_HASHKEY_ANCHOR is on. Not a real on-chain tx; no explorer URL.',
      }
    : null;

  return res.json({
    anchored: false,
    status: 'pending_onchain_anchor',
    onchain_write_implemented: false,
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
      note: 'Locally-computed commitment leaf. Not yet written to any chain.',
    },
    transaction: simulatedTx,
  });
});

export default router;
