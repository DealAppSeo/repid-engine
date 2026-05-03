/**
 * /v1/receipts — HyperDAG RepID Trust Receipt issuance and read endpoints.
 *
 * POST  /v1/receipts             → issueReceipt; returns { receiptJson, receiptUri, receiptHash }
 * GET   /v1/receipts/:receiptId  → returns receiptJson
 * GET   /v1/receipts?agentId=N   → list receipts for an agent
 *
 * Mounted in src/index.ts AFTER auth/rateLimit/versioning so endpoints are
 * authenticated like the rest of /api/v1.
 */
import { Router, Request, Response } from 'express';
import { issueReceipt, getReceiptById, listReceiptsByAgent } from '../services/receipt-issuer';

const router = Router();

router.post('/receipts', async (req: Request, res: Response) => {
  try {
    const required = ['agentId', 'agentWallet', 'x402PaymentProof', 'taskInput', 'taskResult', 'halOutput', 'repIdCommitment', 'scoreVersion'];
    for (const k of required) {
      if (req.body?.[k] === undefined) {
        return res.status(400).json({ error: `Missing required field: ${k}` });
      }
    }
    const out = await issueReceipt(req.body);
    return res.status(201).json({
      receiptJson: out.receiptJson,
      receiptUri: out.receiptUri,
      receiptHash: out.receiptHash,
      contractTxHash: out.contractTxHash,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'receipt issuance failed' });
  }
});

router.get('/receipts/:receiptId', async (req: Request, res: Response) => {
  const id = String(req.params.receiptId ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    return res.status(400).json({ error: 'invalid receiptId' });
  }
  const receiptJson = await getReceiptById(id);
  if (!receiptJson) return res.status(404).json({ error: 'not found' });
  return res.json(receiptJson);
});

router.get('/receipts', async (req: Request, res: Response) => {
  const agentIdRaw = req.query.agentId;
  if (typeof agentIdRaw !== 'string' || !/^\d+$/.test(agentIdRaw)) {
    return res.status(400).json({ error: 'agentId query param required (positive integer)' });
  }
  const agentId = parseInt(agentIdRaw, 10);
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const rows = await listReceiptsByAgent(agentId, limit);
  return res.json({ agentId, count: rows.length, receipts: rows });
});

export default router;
