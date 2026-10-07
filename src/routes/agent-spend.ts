/**
 * POST /api/v1/agents/:id/spend — the agent pays from its owner's wallet, up to the USDC cap the
 * owner approved on-chain. See src/services/agent-spend.ts for why the cap is the token contract.
 *
 * Body: { owner_address, to_address, amount_usdc, dry_run? }
 *
 *   dry_run: true   reads the chain and says whether it WOULD go through, and why not. Signs
 *                   nothing. Works whether or not spending is enabled.
 *   otherwise       needs AGENT_SPEND_ENABLED=true on this server; signs `transferFrom` with the
 *                   agent's own custodied key and returns the transaction and its Basescan link.
 *
 * Auth: the global authMiddleware binds an agent-bound key to its own /agents/<id>/ path, so only
 * the agent's own key (held by its owner) or an operator key reaches this.
 *
 * OWNER [2026-10-07]. `owner_address` must be the wallet BOUND as this agent's owner
 * (human-agent-binding.ts). Before, it could be any wallet that had approved the agent, so the
 * binding — the one record that says whose agent this is — played no part in spending. An unbound
 * agent cannot spend at all; a dry run says why. The on-chain approval is still the cap; this adds
 * "and only from its owner".
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { logAgentEvent } from '../engine/agent-log';
import {
  checkSpend,
  executeSpend,
  formatUsdc,
  parseUsdc,
  rpcSpendChain,
  type SpendChain,
  type SpendRequest,
} from '../services/agent-spend';

const DEFAULT_RPC_URL = 'https://sepolia.base.org';

export interface AgentSpendDeps {
  chain?: SpendChain;
  loadAgent?: (agentId: string) => Promise<{ key: string | null; walletAddress: string | null }>;
  /** The wallet bound as this agent's owner, or null if nobody has bound it. */
  loadOwnerWallet?: (agentId: string) => Promise<string | null>;
  enabled?: () => boolean;
}

async function defaultLoadOwnerWallet(agentId: string): Promise<string | null> {
  const { ownerOfAgent } = require('../services/human-agent-binding') as typeof import('../services/human-agent-binding');
  return ((await ownerOfAgent(agentId))?.human_wallet ?? null) as string | null;
}

async function defaultLoadAgent(agentId: string) {
  // Same lazy-require pattern the minter uses: the custody module pulls in the master-key crypto,
  // which a router that is never called should not load.
  const { getDecryptedPrivateKey } = require('../services/agent-wallet-manager') as typeof import('../services/agent-wallet-manager');
  const { data } = await db.from('repid_agents').select('wallet_address').eq('id', agentId).maybeSingle();
  return { key: await getDecryptedPrivateKey(agentId), walletAddress: ((data as any)?.wallet_address ?? null) as string | null };
}

export function createAgentSpendRouter(deps: AgentSpendDeps = {}): Router {
  const router = Router();
  let chain: SpendChain | null = deps.chain ?? null;
  const getChain = () => (chain ??= rpcSpendChain(process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL));
  const loadAgent = deps.loadAgent ?? defaultLoadAgent;
  const loadOwnerWallet = deps.loadOwnerWallet ?? defaultLoadOwnerWallet;
  const enabled = deps.enabled ?? (() => process.env.AGENT_SPEND_ENABLED === 'true');

  router.post('/:id/spend', async (req: Request, res: Response) => {
    const agentId = String(req.params.id);
    const { owner_address, to_address, amount_usdc, dry_run } = req.body ?? {};
    const amount = parseUsdc(amount_usdc);
    if (amount === null) {
      return res.status(400).json({ ok: false, code: 'bad_amount', error: 'amount_usdc must be a positive number with at most 6 decimals, e.g. "1.25".' });
    }
    if (typeof owner_address !== 'string' || typeof to_address !== 'string') {
      return res.status(400).json({ ok: false, code: 'bad_address', error: 'owner_address and to_address are required.' });
    }
    const spend: SpendRequest = { owner: owner_address.trim(), to: to_address.trim(), amount };
    const isDryRun = dry_run === true;

    if (!isDryRun && !enabled()) {
      return res.status(403).json({
        ok: false,
        code: 'spending_off',
        error: 'Agent spending is off on this server (AGENT_SPEND_ENABLED). A dry run still works. Nothing was sent.',
      });
    }

    try {
      // Whose money: only the bound owner's. Checked before the chain is read, so an unbound
      // agent costs no RPC calls, and the refusal says what to do next.
      const ownerWallet = await loadOwnerWallet(agentId);
      if (!ownerWallet) {
        return res.status(isDryRun ? 200 : 403).json({
          ok: false, dry_run: isDryRun, would_send: false, code: 'not_bound',
          error: 'Nobody has bound this agent yet, so there is no owner whose wallet it may spend from. Bind it first.',
        });
      }
      if (ownerWallet.toLowerCase() !== spend.owner.toLowerCase()) {
        return res.status(isDryRun ? 200 : 403).json({
          ok: false, dry_run: isDryRun, would_send: false, code: 'not_owner',
          error: "owner_address is not this agent's bound owner. An agent spends only from its owner's wallet.",
          bound_owner: ownerWallet,
        });
      }

      const checked = await checkSpend(getChain(), () => loadAgent(agentId), spend);
      const readsOut = checked.reads && {
        cap_usdc: formatUsdc(checked.reads.allowance),
        owner_balance_usdc: formatUsdc(checked.reads.ownerBalance),
        agent_eth: checked.reads.agentEth.toString(),
        chain_id: Number(checked.reads.chainId),
      };
      if (!checked.ok) {
        // agent_wallet is returned on a refusal too: the owner needs it to set the cap at all.
        return res.status(isDryRun ? 200 : checked.status).json({ ok: false, dry_run: isDryRun, would_send: false, code: checked.code, error: checked.message, agent_wallet: checked.agentAddress ?? null, reads: readsOut });
      }
      if (isDryRun) {
        return res.json({ ok: true, dry_run: true, would_send: true, agent_wallet: checked.agentAddress, reads: readsOut });
      }

      const result = await executeSpend(getChain(), checked, spend);
      await logAgentEvent({
        agent: agentId,
        action: 'agent_spend',
        metadata: { tx_hash: result.tx_hash, amount_usdc: result.amount_usdc, to: result.to, owner: result.from_owner, cap_after_usdc: result.cap_after_usdc },
      });
      return res.json({ ok: true, ...result });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[agent-spend] failed:', msg);
      return res.status(502).json({ ok: false, code: 'chain_error', error: `Could not complete the spend: ${msg}` });
    }
  });

  return router;
}
