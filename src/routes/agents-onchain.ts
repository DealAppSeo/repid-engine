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

// Default ERC-8004 IdentityRegistry on Base Sepolia (vanity address, multi-chain).
// Source: hyperdag-protocol/packages/contracts (deployed via vanity-deploy 2026-04).
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
   * Mints an ERC-8004 token for the agent via IdentityRegistry.register(string).
   * Bearer auth required (global authMiddleware).
   * Query: ?dry_run=true → returns gas estimate without sending tx.
   * Body (optional): { agent_uri?: string }
   */
  router.post('/:id/mint', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const isDryRun = req.query.dry_run === 'true';
    try {
      const minter = getMinter();
      if (isDryRun) {
        const estimate = await minter.estimateGas({
          agentId: id,
          agentURI: req.body?.agent_uri,
        });
        res.status(200).json({
          dry_run: true,
          estimated_gas: estimate.toString(),
          agent_id: id,
          signer_address: minter.getSignerAddress(),
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
