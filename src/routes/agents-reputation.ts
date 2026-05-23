// ERC-8004 ReputationRegistry surface for repid_agents.
//
// Routes (mounted at /api/v1 in src/index.ts):
//   POST /api/v1/agents/:id/reputation/write
//     Bearer auth required (global authMiddleware). Writes the agent's
//     current RepID to canonical ReputationRegistry. Body: { dry_run?: bool }
//   GET  /api/v1/agents/:id/reputation/payload.json
//     Public. Off-chain feedback file pointed to by `feedbackURI` in the
//     giveFeedback call. Spec calls this the "feedback file".
//   GET  /api/v1/agents/:id/reputation/onchain
//     Public. Reads HyperDAG's feedback summary directly from the canonical
//     ReputationRegistry on-chain. Cross-verifies the DB cache.
import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getReputationWriter,
  persistReputationWrite,
  Erc8004ReputationWriter,
} from '../services/erc8004-reputation';
import { pgQuery } from '../db/direct-pg';

const DEFAULT_REPUTATION_CONTRACT =
  Erc8004ReputationWriter.DEFAULTS.BASE_SEPOLIA_REPUTATION;
const DEFAULT_IDENTITY_REGISTRY =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e';

function basescanTxUrl(chainId: number | null, txHash: string): string {
  return chainId === 84532 || chainId === null
    ? `https://sepolia.basescan.org/tx/${txHash}`
    : `https://basescan.org/tx/${txHash}`;
}

export function createAgentsReputationRouter(
  supabase: SupabaseClient
): Router {
  const router = Router();

  // ---------------------------------------------------------------
  // POST /agents/:id/reputation/write  (Bearer auth)
  //
  // @deprecated since Phase 8 (2026-05-21). The FeedbackLoopWorker
  // (src/workers/feedback-loop-worker.ts) now wires the automatic
  // on-chain write path triggered by repid_events of type
  // x402_inbound_settled / x402_outbound_settled. This manual
  // endpoint remains live as an operator force-write surface (e.g.,
  // for ad-hoc reconciliation, backfill scripting, or testing) but
  // routine reputation propagation should flow through the worker.
  // Removal target: V1.x or later, gated on observed worker stability
  // and no operator dependence on this endpoint. Sean strategic
  // ruling 2026-05-21.
  // ---------------------------------------------------------------
  router.post(
    '/agents/:id/reputation/write',
    async (req: Request, res: Response) => {
      try {
        const writer = getReputationWriter();
        if (!writer) {
          res.status(503).json({
            error: 'reputation_writer_not_configured',
            detail:
              'Set ERC8004_REPUTATION_WRITER_KEY (or ERC8004_MINTER_PRIVATE_KEY) on Railway.',
          });
          return;
        }

        const { data: agent, error: lookupErr } = await supabase
          .from('repid_agents')
          .select(
            'id, agent_name, current_repid, tier, erc8004_token_id, mint_chain_id, reputation_write_count'
          )
          .eq('id', String(req.params.id))
          .single();
        if (lookupErr || !agent) {
          res.status(404).json({ error: 'agent_not_found' });
          return;
        }
        if (!agent.erc8004_token_id) {
          res.status(409).json({
            error: 'agent_not_minted',
            detail:
              'Agent must be minted on the canonical IdentityRegistry before its reputation can be written.',
          });
          return;
        }
        if (agent.current_repid == null) {
          res.status(409).json({ error: 'agent_has_no_repid' });
          return;
        }

        if (req.body && req.body.dry_run === true) {
          const est = await writer.estimateWriteGas({
            agentTokenId: agent.erc8004_token_id,
            repid: agent.current_repid,
            tier: agent.tier,
          });
          res.status(200).json({
            dry_run: true,
            agent_id: agent.id,
            agent_name: agent.agent_name,
            token_id: agent.erc8004_token_id,
            repid: agent.current_repid,
            tier: agent.tier,
            gas_estimate: est.gasEstimate.toString(),
            gas_price_gwei: est.gasPriceGwei,
            operator_address: await writer.getOperatorAddress(),
            contract: writer.getContractAddress(),
          });
          return;
        }

        // Live write.
        const baseUrl =
          process.env.PUBLIC_ENGINE_BASE_URL ||
          'https://repid-engine-production.up.railway.app';
        const feedbackURI = `${baseUrl}/api/v1/agents/${agent.id}/reputation/payload.json`;
        const endpoint = `${baseUrl}/api/v1/agents/${agent.id}`;

        const result = await writer.writeRepIDFeedback({
          agentTokenId: agent.erc8004_token_id,
          repid: agent.current_repid,
          tier: agent.tier,
          endpoint,
          feedbackURI,
        });

        const chainId = agent.mint_chain_id || writer.chainId || 84532;

        await persistReputationWrite(supabase, {
          agent_id: agent.id,
          agent_token_id: agent.erc8004_token_id,
          repid_value: agent.current_repid,
          tier: agent.tier,
          tx_hash: result.txHash,
          block_number: result.blockNumber,
          gas_used: result.gasUsed,
          chain_id: chainId,
          contract_address:
            process.env.ERC8004_REPUTATION_CONTRACT ||
            DEFAULT_REPUTATION_CONTRACT,
        });

        const nextCount =
          ((agent as { reputation_write_count?: number }).reputation_write_count ??
            0) + 1;
        await supabase
          .from('repid_agents')
          .update({
            last_reputation_tx_hash: result.txHash,
            last_reputation_block_number: result.blockNumber,
            last_reputation_repid: agent.current_repid,
            last_reputation_written_at: new Date().toISOString(),
            reputation_write_count: nextCount,
          })
          .eq('id', agent.id);

        res.status(200).json({
          success: true,
          agent_id: agent.id,
          agent_name: agent.agent_name,
          token_id: agent.erc8004_token_id,
          repid: agent.current_repid,
          tier: agent.tier,
          tx_hash: result.txHash,
          block_number: result.blockNumber,
          gas_used: result.gasUsed,
          chain_id: chainId,
          basescan_url: basescanTxUrl(chainId, result.txHash),
          operator_address: await writer.getOperatorAddress(),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[agents-reputation] write failed:', msg);
        res.status(500).json({ error: 'write_failed', message: msg });
      }
    }
  );

  // ---------------------------------------------------------------
  // GET /agents/:id/reputation/payload.json  (public)
  // ---------------------------------------------------------------
  router.get(
    '/agents/:id/reputation/payload.json',
    async (req: Request, res: Response) => {
      try {
        const { data: agent, error } = await supabase
          .from('repid_agents')
          .select(
            'id, agent_name, current_repid, tier, erc8004_token_id, mint_chain_id, last_reputation_written_at'
          )
          .eq('id', String(req.params.id))
          .single();
        if (error || !agent || !agent.erc8004_token_id) {
          res.status(404).json({ error: 'not_found_or_not_minted' });
          return;
        }

        const chainId = agent.mint_chain_id || 84532;
        const caip = `eip155:${chainId}:${DEFAULT_IDENTITY_REGISTRY}`;
        const baseUrl =
          process.env.PUBLIC_ENGINE_BASE_URL ||
          'https://repid-engine-production.up.railway.app';

        // HAL enrichment (2026-05-22): surface recent HAL signals so off-chain
        // ERC-8004 verifiers reading this feedbackURI see real HAL, not just the
        // cumulative score. Bounded LIMIT 20 (RULE-8) via pgQuery. ADDITIVE +
        // degrade-gracefully: if the query fails (e.g. DATABASE_URL unset in this
        // env), hal_summary is null and every other field is unchanged — no
        // existing consumer breaks (Branch D contingency).
        let hal_summary: Record<string, unknown> | null = null;
        try {
          const rows = await pgQuery<{
            event_type: string;
            hal_score: number | null;
            hal_decision: string | null;
            created_at: string;
          }>(
            `SELECT event_type, hal_score, hal_decision, created_at
             FROM repid_score_events
             WHERE agent_id = $1
             ORDER BY created_at DESC
             LIMIT 20`,
            [String(req.params.id)],
            { retries: 1, label: 'reputation:hal-summary' }
          );
          const scored = rows.filter((r) => typeof r.hal_score === 'number');
          const aggregate =
            scored.length > 0
              ? scored.reduce((s, r) => s + (r.hal_score as number), 0) / scored.length
              : null;
          hal_summary = {
            recent_events: rows.map((r) => ({
              type: r.event_type,
              hal_score: r.hal_score,
              hal_decision: r.hal_decision,
              timestamp: r.created_at,
            })),
            aggregate_hal_score: aggregate,
            veto_count: rows.filter((r) => r.hal_decision === 'vetoed').length,
            flagged_count: rows.filter((r) => r.hal_decision === 'flagged').length,
            sample_size: rows.length,
          };
        } catch (halErr: unknown) {
          const msg = halErr instanceof Error ? halErr.message : String(halErr);
          console.error('[agents-reputation] hal_summary query failed (omitting):', msg);
          hal_summary = null;
        }

        res.setHeader('Cache-Control', 'public, max-age=60');
        res.status(200).json({
          version: 'hyperdag-feedback-v1',
          agentRegistry: caip,
          agentId: agent.erc8004_token_id,
          clientAddress: process.env.ERC8004_OPERATOR_ADDRESS || '0x0',
          createdAt:
            agent.last_reputation_written_at || new Date().toISOString(),
          value: agent.current_repid,
          valueDecimals: 0,
          tags: {
            hyperdag_repid: true,
            tier: agent.tier,
          },
          hal_summary,
          hyperdag: {
            tier: agent.tier,
            verifier_package: '@hyperdag/proof-verifier@^0.1.0',
            verify_url: `${baseUrl}/api/v1/agents/${agent.id}/verify`,
          },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[agents-reputation] payload.json failed:', msg);
        res.status(500).json({ error: 'payload_failed', message: msg });
      }
    }
  );

  // ---------------------------------------------------------------
  // GET /agents/:id/reputation/onchain  (public)
  // ---------------------------------------------------------------
  router.get(
    '/agents/:id/reputation/onchain',
    async (req: Request, res: Response) => {
      try {
        const writer = getReputationWriter();
        if (!writer) {
          res.status(503).json({ error: 'reader_not_configured' });
          return;
        }
        const { data: agent, error } = await supabase
          .from('repid_agents')
          .select('id, agent_name, erc8004_token_id')
          .eq('id', String(req.params.id))
          .single();
        if (error || !agent || !agent.erc8004_token_id) {
          res.status(404).json({ error: 'not_found_or_not_minted' });
          return;
        }
        const summary = await writer.readHyperDAGFeedback(agent.erc8004_token_id);
        res.status(200).json({
          agent_id: agent.id,
          agent_name: agent.agent_name,
          token_id: agent.erc8004_token_id,
          feedback_count: summary.count,
          latest_value: summary.summaryValue.toString(),
          value_decimals: summary.summaryValueDecimals,
          operator_address: await writer.getOperatorAddress(),
          contract: writer.getContractAddress(),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[agents-reputation] onchain read failed:', msg);
        res.status(500).json({ error: 'read_failed', message: msg });
      }
    }
  );

  return router;
}
