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
 *
 * OWNER BUDGET [2026-11-14]. The approval is per AGENT, so N agents of one owner could each spend
 * the whole stake. With OWNER_BUDGET_MODE=enforce every agent of one owner spends against ONE
 * budget, the owner's funded stake (src/services/owner-budget.ts): the amount is reserved in
 * Postgres BEFORE signing, settled on a good receipt, released only on a reverted one, and left
 * counting when the outcome is unknown. Off by default; `shadow` logs what it would refuse.
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
  SpendRevertedError,
  type SpendChain,
  type SpendRequest,
} from '../services/agent-spend';
import {
  ownerBudgetMode,
  ownerBuilderOfAgent,
  supabaseOwnerBudget,
  type OwnerBudgetMode,
  type OwnerBudgetStore,
} from '../services/owner-budget';

const DEFAULT_RPC_URL = 'https://sepolia.base.org';

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function budgetOut(budget: bigint, committed: bigint) {
  const left = budget > committed ? budget - committed : 0n;
  return { budget_usdc: formatUsdc(budget), committed_usdc: formatUsdc(committed), remaining_usdc: formatUsdc(left) };
}

function overBudget(amount: bigint, s: { budget: bigint; committed: bigint }) {
  const { budget_usdc, remaining_usdc } = budgetOut(s.budget, s.committed);
  return `over the owner's shared budget: ${formatUsdc(amount)} USDC asked, ${remaining_usdc} USDC left of ${budget_usdc} USDC funded across all of this owner's agents. Nothing was sent.`;
}

export interface AgentSpendDeps {
  chain?: SpendChain;
  loadAgent?: (agentId: string) => Promise<{ key: string | null; walletAddress: string | null }>;
  /** The wallet bound as this agent's owner, or null if nobody has bound it. */
  loadOwnerWallet?: (agentId: string) => Promise<string | null>;
  enabled?: () => boolean;
  /** The owner's account (builder) whose stake is the shared budget, or null if not a builder. */
  loadOwnerBuilder?: (agentId: string) => Promise<string | null>;
  ownerBudget?: OwnerBudgetStore;
  budgetMode?: () => OwnerBudgetMode;
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
  const loadOwnerBuilder = deps.loadOwnerBuilder ?? ownerBuilderOfAgent;
  const budget = deps.ownerBudget ?? supabaseOwnerBudget;
  const budgetMode = deps.budgetMode ?? (() => ownerBudgetMode());

  router.post('/:id/spend', async (req: Request, res: Response) => {
    const agentId = String(req.params.id);
    // WHO MAY ASK [2026-11-14]. Only this agent's own key, or an operator key (ops tier, bound to
    // no agent). Checked HERE, not left to authMiddleware's path check: that compared the raw URL
    // while this handler reads the decoded id, and a shared REPID_API_KEYS key bound to no agent
    // skips it entirely, so either one could make ANOTHER owner's agent sign (Strix on #1550).
    const callerAgent = (req as any).agent_id as string | undefined;
    const operator = !callerAgent && (req as any).apiKey?.tier === 'ops';
    if (!operator && (!callerAgent || callerAgent.toLowerCase() !== agentId.toLowerCase())) {
      return res.status(403).json({
        ok: false, would_send: false, code: 'not_this_agent',
        error: "Only this agent's own key, or an operator key, may spend for it. Nothing was sent.",
      });
    }
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
      // agent costs no RPC calls, and the refusal says what to do next. Checked on EVERY spend, so
      // an unbind stops the next one. [F1] A failed read is "not checked" (503), never "unbound"
      // and never a chain error: we did not look, and nothing was sent.
      let ownerWallet: string | null;
      try {
        ownerWallet = await loadOwnerWallet(agentId);
      } catch (e: unknown) {
        return res.status(503).json({
          ok: false, dry_run: isDryRun, would_send: false, code: 'owner_not_checked',
          error: `Could not read who owns this agent, so nothing was sent. ${e instanceof Error ? e.message : String(e)}`.trim(),
        });
      }
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
      // OWNER BUDGET: after every chain refusal (a refused spend reserves nothing), before signing.
      const mode = budgetMode();
      const notChecked = (e: unknown) =>
        res.status(503).json({
          ok: false, dry_run: isDryRun, would_send: false, code: 'owner_budget_not_checked',
          error: `Could not read this owner's shared budget, so nothing was sent. ${msgOf(e)}`.trim(),
        });
      let builderId: string | null = null;
      if (mode !== 'off') {
        try {
          builderId = await loadOwnerBuilder(agentId);
        } catch (e: unknown) {
          if (mode === 'enforce') return notChecked(e);
          console.warn(`[owner-budget] shadow: owner lookup failed for agent ${agentId}: ${msgOf(e)}`);
        }
      }
      if (mode === 'enforce' && !builderId) {
        return res.status(isDryRun ? 200 : 403).json({
          ok: false, dry_run: isDryRun, would_send: false, code: 'no_owner_budget',
          error: "This agent's owner has no account whose stake funds a budget, so it cannot spend. Bind it from a wallet account and stake first.",
        });
      }

      if (isDryRun) {
        let ownerBudget: ReturnType<typeof budgetOut> | undefined;
        if (builderId) {
          try {
            const s = await budget.status(builderId);
            ownerBudget = budgetOut(s.budget, s.committed);
            if (mode === 'enforce' && s.committed + amount > s.budget) {
              return res.json({ ok: false, dry_run: true, would_send: false, code: 'over_owner_budget', error: overBudget(amount, s), agent_wallet: checked.agentAddress, reads: readsOut, owner_budget: ownerBudget });
            }
          } catch (e: unknown) {
            if (mode === 'enforce') return notChecked(e);
            console.warn(`[owner-budget] shadow: budget read failed for agent ${agentId}: ${msgOf(e)}`);
          }
        }
        return res.json({ ok: true, dry_run: true, would_send: true, agent_wallet: checked.agentAddress, reads: readsOut, ...(ownerBudget ? { owner_budget: ownerBudget } : {}) });
      }

      let reservationId: string | null = null;
      if (mode === 'enforce') {
        let r;
        try {
          r = await budget.reserve(builderId!, agentId, amount);
        } catch (e: unknown) {
          return notChecked(e);
        }
        if (!r.ok || !r.id) {
          return res.status(409).json({ ok: false, dry_run: false, would_send: false, code: 'over_owner_budget', error: overBudget(amount, r), owner_budget: budgetOut(r.budget, r.committed) });
        }
        reservationId = r.id;
      } else if (mode === 'shadow' && builderId) {
        try {
          const s = await budget.status(builderId);
          if (s.committed + amount > s.budget) console.warn(`[owner-budget] shadow: WOULD REFUSE agent ${agentId}: ${overBudget(amount, s)}`);
        } catch (e: unknown) {
          console.warn(`[owner-budget] shadow: budget read failed for agent ${agentId}: ${msgOf(e)}`);
        }
      }

      let result;
      try {
        result = await executeSpend(getChain(), checked, spend);
      } catch (e: unknown) {
        if (reservationId) {
          // Only a reverted receipt proves no USDC moved. Anything else may have landed, so it keeps counting.
          const reverted = e instanceof SpendRevertedError;
          const state = reverted ? 'released' : 'unknown';
          await budget
            .finish(reservationId, state, reverted ? (e as SpendRevertedError).txHash : null, msgOf(e))
            .catch((fe: unknown) => console.error(`[owner-budget] reservation ${reservationId} could not be marked ${state}; it stays reserved and keeps counting: ${msgOf(fe)}`));
        }
        throw e;
      }
      if (reservationId) {
        await budget
          .finish(reservationId, 'settled', result.tx_hash, 'receipt status 1')
          .catch((fe: unknown) => console.error(`[owner-budget] reservation ${reservationId} for tx ${result.tx_hash} could not be marked settled; it stays reserved and keeps counting: ${msgOf(fe)}`));
      } else if (mode === 'shadow' && builderId) {
        await budget
          .recordSettled(builderId, agentId, amount, result.tx_hash)
          .catch((fe: unknown) => console.warn(`[owner-budget] shadow: could not record settled tx ${result.tx_hash}: ${msgOf(fe)}`));
      }
      await logAgentEvent({
        agent: agentId,
        action: 'agent_spend',
        metadata: { tx_hash: result.tx_hash, amount_usdc: result.amount_usdc, to: result.to, owner: result.from_owner, cap_after_usdc: result.cap_after_usdc, owner_budget_reservation: reservationId },
      });
      return res.json({ ok: true, ...result, ...(reservationId ? { owner_budget_reservation: reservationId } : {}) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[agent-spend] failed:', msg);
      return res.status(502).json({ ok: false, code: 'chain_error', error: `Could not complete the spend: ${msg}` });
    }
  });

  return router;
}
