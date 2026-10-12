// GET /api/v1/passport/:agentId — the public Agent Trust Passport.
//
// The one-call composite a counterparty (merchant, marketplace, another agent)
// hits before authorizing an agent: RepID + tier, ERC-8004 identity metadata
// with a live-verification link, real-vs-simulated x402 settlement history,
// on-chain reputation write count, and the latest ZKP proof labeled honestly.
//
// The `onchain` object folds the LIVE ownership read into this one call, so a client no longer
// makes a second call to GET /api/v1/agents/:id/onchain per minted record to verify on chain
// (trustshell #523 was that interim second call). The read is the SAME one that route uses
// (Erc8004Minter.verifyOnChain, OWNER_FOUND path) — bounded, cached, and fail-safe (a chain outage
// yields onchain.verified=false with the recorded state intact, never a slow or wrong passport).
// The passport stays DB-first everywhere else.
//
// Public surface — mounted BEFORE authMiddleware in src/index.ts, same as the
// observability/repid public routers. CORS is pinned globally to the Trust*
// frontends (tests/cors-origins.test.ts). DB-first: no per-request RPC except the one bounded,
// cached ownership read above.
import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../../db';
import { buildAgentPassport, PassportQueryError } from '../../services/agent-passport';
import type { OnchainReader } from '../../services/passport-onchain';
import { resolveOnchainRead, type RawOnchainRead } from '../../cache/passport-onchain-cache';
import { Erc8004Minter } from '../../services/erc8004-minter';

// Read-only IdentityRegistry defaults (mirror the read paths in routes/agents-onchain.ts).
const DEFAULT_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const DEFAULT_CHAIN_ID = 84532; // Base Sepolia
const DEFAULT_RPC_URL = 'https://sepolia.base.org';
// Read-only: ownerOf is a free eth_call; the signer is never used. A throwaway key keeps the
// Wallet constructor happy without requiring a secret (same pattern as the /onchain GET route).
const READ_ONLY_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

/**
 * Build the live ownership reader the passport injects: it reuses Erc8004Minter.verifyOnChain (the
 * exact read behind GET /:id/onchain) and wraps it in the bounded, cached resolver. The minter is
 * constructed lazily on first use, so importing this module reaches no chain and starts no provider.
 */
export function makePassportOnchainReader(supabase: SupabaseClient): OnchainReader {
  let minter: Erc8004Minter | null = null;
  const getMinter = (): Erc8004Minter => {
    if (minter) return minter;
    minter = new Erc8004Minter({
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL,
      contractAddress: process.env.TRUST_IDENTITY_REGISTRY || DEFAULT_IDENTITY_REGISTRY,
      minterPrivateKey: READ_ONLY_KEY,
      chainId: parseInt(process.env.BASE_SEPOLIA_CHAIN_ID || String(DEFAULT_CHAIN_ID), 10),
      supabase,
    });
    return minter;
  };
  const rawRead = async (agentId: string): Promise<RawOnchainRead> => {
    const v = await getMinter().verifyOnChain(agentId);
    return { check: v.check, owner: v.onChainOwner, block: v.block, registry: v.registry, chainId: v.chainId };
  };
  return (agentId: string) => resolveOnchainRead(agentId, rawRead);
}

/**
 * The passport router. Pass `onchainRead` to fold the live ownership read into the payload; omit it
 * (the default export does) for a hermetic, DB-only passport with onchain.verified=false.
 */
export function createAgentPassportRouter(onchainRead?: OnchainReader): Router {
  const router = Router();

  router.get('/passport/:agentId', async (req: Request, res: Response) => {
    try {
      const passport = await buildAgentPassport(db, String(req.params.agentId ?? ''), { onchainRead });
      if (!passport) {
        return res.status(404).json({ error: 'agent_not_found' });
      }
      // Modest edge cache: passports change on score events, not per-request.
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.json(passport);
    } catch (e: unknown) {
      if (e instanceof PassportQueryError) {
        console.error(`[passport] ${e.message}`);
        return res.status(500).json({ error: 'query_failed', step: e.step });
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[passport] unexpected: ${msg}`);
      return res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}

// Default export: DB-only (no live reader). Kept so existing importers and tests get a passport
// that reaches no chain. src/index.ts mounts createAgentPassportRouter(makePassportOnchainReader(db)).
export default createAgentPassportRouter();
