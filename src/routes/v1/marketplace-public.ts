/**
 * Buy-loop last mile (2026-07-06) — public marketplace read surface.
 *
 * GET /api/v1/marketplace/recent-transactions
 *   Returns the last N settled service contracts (real + simulated), joined to
 *   their x402 settlement, for the /market page's "recent settlements" panel.
 * GET /api/v1/marketplace/mock-receipt
 *   One simulated fixture (same field names) so TrustMarket can hang a
 *   first-receipt UI. Always is_simulated=true. Does not flip settlement.
 *
 * PUBLIC (read-only): this router is mounted BEFORE authMiddleware in
 * src/index.ts, so it needs no API key — same posture as the other public
 * GET /api/v1/repid/* reads. It performs NO writes and moves NO money.
 *
 * It lives in a SEPARATE file (not marketplace.ts) so it never touches the
 * intentionally settlement-disabled V2 marketplace router.
 *
 * Honesty: every row carries an explicit `is_simulated` flag (sourced from the
 * x402 settlement, falling back to the contract) so the UI can label simulated
 * activity truthfully. `tx_hash` is only populated for real on-chain
 * settlements; simulated rows report null. Nothing secret is exposed — only
 * agent ids/names, service type, amount, sim flag, tx hash, timestamp.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';

const router = Router();

// Base direction is service_contracts because it holds settled_at + fulfilled_at
// and the FKs to the settlement, the service (for service_type), and both
// agents. PostgREST embeds:
//   x402_settlements  via service_contracts.x402_payment_id  (is_simulated, tx_hash, amount, asset, created_at)
//   agent_services    via service_contracts.service_id       (service_type, service_name)
//   provider/buyer    via the two agent FKs                  (agent_name)
const SELECT_SHAPE = `
  id,
  status,
  agreed_price_usdc_raw,
  settled_at,
  fulfilled_at,
  created_at,
  provider_agent_id,
  buyer_agent_id,
  metadata,
  x402_settlements:x402_payment_id ( id, amount, asset, is_simulated, tx_hash, status, created_at ),
  agent_services:service_id ( service_type, service_name ),
  provider:provider_agent_id ( agent_name ),
  buyer:buyer_agent_id ( agent_name )
`;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

router.get('/recent-transactions', async (req: Request, res: Response) => {
  try {
    const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    // Only contracts that reached a settled economic state, ordered newest-first
    // by when they settled. `settled_at` is set on the satisfy→settled step;
    // fall back to created_at ordering for rows without it.
    const { data, error } = await db
      .from('service_contracts')
      .select(SELECT_SHAPE)
      .in('status', ['settled', 'satisfied', 'fulfilled'])
      .not('x402_payment_id', 'is', null)
      .order('settled_at', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (error) {
      console.error('[marketplace-public] recent-transactions query failed:', error.message ?? error);
      return res.status(500).json({ error: 'query_failed', message: error.message ?? 'query failed' });
    }

    const rows = (data ?? []).map((c: any) => {
      const settlement = c.x402_settlements ?? null;
      const service = c.agent_services ?? null;
      // Honest sim flag: prefer the settlement's flag; fall back to the
      // contract metadata; default to false only when neither is present.
      const isSimulated =
        settlement?.is_simulated ??
        (c.metadata && typeof c.metadata === 'object' ? (c.metadata as any).is_simulated : undefined) ??
        false;
      // tx_hash only meaningful for a real settlement.
      const txHash = isSimulated ? null : (settlement?.tx_hash ?? null);

      return {
        contract_id: c.id,
        service_type: service?.service_type ?? null,
        service_name: service?.service_name ?? null,
        amount: settlement?.amount ?? c.agreed_price_usdc_raw ?? null,
        asset: settlement?.asset ?? 'USDC',
        is_simulated: Boolean(isSimulated),
        tx_hash: txHash,
        status: c.status,
        provider_agent_id: c.provider_agent_id,
        provider_agent_name: c.provider?.agent_name ?? null,
        buyer_agent_id: c.buyer_agent_id,
        buyer_agent_name: c.buyer?.agent_name ?? null,
        settled_at: c.settled_at ?? c.fulfilled_at ?? c.created_at ?? null,
      };
    });

    return res.json({
      count: rows.length,
      limit,
      transactions: rows,
    });
  } catch (e: any) {
    console.error('[marketplace-public] recent-transactions unexpected error:', e?.message ?? String(e));
    return res.status(500).json({ error: 'internal_error', message: e?.message ?? String(e) });
  }
});

/**
 * GET /api/v1/marketplace/mock-receipt
 *
 * One simulated settlement row, same field names as /recent-transactions, so
 * TrustMarket can hang a first-receipt UI without waiting for a live settle
 * and without flipping MARKETPLACE_SETTLEMENT_ENABLED (hard-off in marketplace.ts;
 * env is not consulted here either).
 *
 * No DB write. No money. tx_hash is always null. is_simulated is always true.
 * Synthetic contract_id (00000000-…) — not a production extract.
 */
export const MOCK_RECEIPT_CONTRACT_ID = '00000000-0000-0000-0000-000000000001';

router.get('/mock-receipt', (_req: Request, res: Response) => {
  return res.json({
    kind: 'mock_receipt',
    contract_id: MOCK_RECEIPT_CONTRACT_ID,
    service_type: 'verification',
    service_name: 'Verify-a-claim',
    amount: 100000,
    asset: 'USDC',
    is_simulated: true,
    tx_hash: null,
    status: 'settled',
    provider_agent_id: '00000000-0000-0000-0000-000000000002',
    provider_agent_name: 'trinity-shofet',
    buyer_agent_id: '00000000-0000-0000-0000-000000000003',
    buyer_agent_name: 'trinity-nexus',
    settled_at: '2026-09-20T00:00:00.000Z',
    settlement_enabled: false,
    receipt_json_path: `/api/v1/receipt/${MOCK_RECEIPT_CONTRACT_ID}.json`,
    note: 'Simulated fixture for TrustMarket first-receipt UI. No money moved. MARKETPLACE_SETTLEMENT_ENABLED stays hard-off.',
  });
});

export default router;
