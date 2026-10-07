// On-chain mint surface for repid_agents.
//
// Routes (mounted at /api/v1/agents in src/index.ts):
//   POST /:id/mint           — auth required; mints via Erc8004Minter
//   GET  /:id/mint-status    — public; reads DB-recorded mint metadata
//   GET  /:id/onchain        — public; cross-verifies on-chain ownerOf vs DB
//
// The minter is instantiated lazily on the first POST request so missing
// env vars (TRUST_IDENTITY_REGISTRY, ERC8004_MINTER_PRIVATE_KEY) don't crash
// app boot. Read-only routes work without these env vars.
import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Erc8004Minter } from '../services/erc8004-minter';
import { matchEnvOperatorKey } from '../auth/api-keys';
import { agentRefColumn } from '../services/human-agent-binding';

// Default ERC-8004 IdentityRegistry on Base Sepolia: the ERC-8004 team's canonical deployment
// (vanity address, multi-chain). We use it; we do not operate it. See BUILDERS.md in
// DealAppSeo/hyperdag-protocol.
const DEFAULT_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const DEFAULT_CHAIN_ID = 84532; // Base Sepolia
const DEFAULT_RPC_URL = 'https://sepolia.base.org';

export function createAgentsOnchainRouter(supabase: SupabaseClient): Router {
  const router = Router();

  let cachedMinter: Erc8004Minter | null = null;
  function getMinter(): Erc8004Minter {
    if (cachedMinter) return cachedMinter;
    const pk = process.env.ERC8004_MINTER_PRIVATE_KEY;
    if (!pk) {
      throw new Error(
        'ERC8004_MINTER_PRIVATE_KEY env var required. SEAN DOES THIS FIRST.'
      );
    }
    cachedMinter = new Erc8004Minter({
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL,
      contractAddress:
        process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY,
      minterPrivateKey: pk,
      chainId: parseInt(
        process.env.BASE_SEPOLIA_CHAIN_ID || String(DEFAULT_CHAIN_ID),
        10
      ),
      supabase,
    });
    return cachedMinter;
  }

  /**
   * POST /:id/mint
   * Mints an ERC-8004 token for the agent via IdentityRegistry.register(string), sent BY
   * THE AGENT'S OWN WALLET so it owns the identity; the minter key only funds gas.
   * Bearer auth required (global authMiddleware).
   * Query: ?dry_run=true → returns gas estimate without sending tx.
   * Body (optional): { agent_uri?: string }
   */
  router.post('/:id/mint', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const isDryRun = req.query.dry_run === 'true';
    // [F-6, 2026-10-07] WHO MAY MINT. Any valid key could mint for any agent: the minter pays the
    // gas, and the auth middleware binds an agent key only to a UUID in the path, so a key for one
    // agent could mint another by NAME. Now: the operator's key, or the agent's OWN key. A dry run
    // spends nothing and stays open to any key.
    if (!isDryRun) {
      const presented = String(req.headers['x-api-key'] ?? '').trim() ||
        String(req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();
      if (!matchEnvOperatorKey(presented)) {
        const callerAgentId = (req as any).agent_id as string | undefined;
        if (!callerAgentId) {
          res.status(403).json({ error: 'mint_not_yours', message: 'Only the operator, or the agent itself with its own key, may mint its identity.' });
          return;
        }
        const { data, error } = await supabase.from('repid_agents').select('id').eq(agentRefColumn(id), id);
        if (error) {
          res.status(503).json({ error: 'not_checked', message: `Could not check which agent ${id} is, so nothing was minted: ${error.message}` });
          return;
        }
        const rows = (data ?? []) as Array<{ id: string }>;
        if (rows.length !== 1 || rows[0]!.id.toLowerCase() !== callerAgentId.toLowerCase()) {
          res.status(403).json({ error: 'mint_not_yours', message: 'This key belongs to a different agent. An agent may mint only its own identity.' });
          return;
        }
      }
    }
    try {
      const minter = getMinter();
      if (isDryRun) {
        const preview = await minter.previewMint({
          agentId: id,
          agentURI: req.body?.agent_uri,
        });
        res.status(200).json({
          dry_run: true,
          estimated_gas: preview.estimatedGas.toString(),
          agent_id: id,
          // The agent's own wallet registers, so it owns the identity and acts as it.
          registrant_address: preview.registrantAddress,
          // The minter only pays gas, and never owns the token.
          gas_funder_address: preview.gasFunderAddress,
        });
        return;
      }
      const result = await minter.mint({
        agentId: id,
        agentURI: req.body?.agent_uri,
      });
      res.status(200).json(result);
      return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already minted')) {
        res.status(409).json({ error: msg });
        return;
      }
      // Refused so that the identity never lands on a shared address: the agent has no
      // wallet of its own, its key does not match its recorded wallet, or it IS the minter.
      if (
        msg.includes('has no wallet of its own') ||
        msg.includes('is not for its recorded wallet') ||
        msg.includes('refusing to mint to a shared address')
      ) {
        res.status(409).json({ error: msg });
        return;
      }
      if (msg.includes('env var required')) {
        res.status(503).json({ error: msg });
        return;
      }
      console.error('[agents-onchain] mint failed:', msg);
      res.status(500).json({ error: msg });
      return;
    }
  });

  /**
   * GET /:id/mint-status
   * Read-only mint metadata from Supabase. Public — no auth.
   */
  router.get('/:id/mint-status', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const minter = process.env.ERC8004_MINTER_PRIVATE_KEY
        ? getMinter()
        : new Erc8004Minter({
            rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL,
            contractAddress:
              process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY,
            // read-only path doesn't sign; supply a throwaway key so the
            // signer constructor doesn't blow up. The signer is never used.
            minterPrivateKey:
              '0x0000000000000000000000000000000000000000000000000000000000000001',
            chainId: parseInt(
              process.env.BASE_SEPOLIA_CHAIN_ID || String(DEFAULT_CHAIN_ID),
              10
            ),
            supabase,
          });
      const status = await minter.getMintStatus(id);
      res.status(200).json(status);
      return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
      return;
    }
  });

  /**
   * GET /:id/onchain
   * Cross-verifies DB-stored token_id against on-chain ownerOf.
   * Useful for the public verification surface (LinkedIn / Basescan).
   * Public — no auth.
   */
  router.get('/:id/onchain', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const minter = process.env.ERC8004_MINTER_PRIVATE_KEY
        ? getMinter()
        : new Erc8004Minter({
            rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL,
            contractAddress:
              process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY,
            minterPrivateKey:
              '0x0000000000000000000000000000000000000000000000000000000000000001',
            chainId: parseInt(
              process.env.BASE_SEPOLIA_CHAIN_ID || String(DEFAULT_CHAIN_ID),
              10
            ),
            supabase,
          });
      const verification = await minter.verifyOnChain(id);
      res.status(200).json(verification);
      return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
      return;
    }
  });

  return router;
}
