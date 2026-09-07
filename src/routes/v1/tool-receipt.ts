/**
 * POST /api/v1/tool-receipt — authed, server-side minting of a signed
 * trustshell_tool_receipt.
 *
 * WHY THIS EXISTS: write_tool_receipt() is EXECUTE-restricted to service_role, and
 * it signs each receipt with a key the caller never sees (minted_by=session_user,
 * unforgeable). So a client-side SDK / agent on the anon key CANNOT mint a receipt
 * itself — correct posture. This endpoint is the bridge: an authed caller posts the
 * PRE-COMPUTED sha256 hashes of its tool input/output, and the engine (service_role)
 * calls the RPC on its behalf. Raw tool I/O never leaves the caller — only 64-hex
 * digests — which is both the privacy posture and why the global SQL-keyword
 * sanitizer never trips on this body.
 *
 * Auth: mounted under the v1 router, behind authMiddleware (REPID_API_KEYS). There is
 * no anon bypass for POST, so every mint is attributable to an API key.
 *
 * Body: { agent_id, tool_name, input_hash, output_hash, vertical?, tool_version?, execution_time_ms? }
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { writeToolReceipt, verifiedReceiptStats, listVerifiedReceipts } from '../../services/trustshell-tool-receipt';

const router = Router();

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * GET /api/v1/tool-receipt/verified — the honest receipt feed. Returns ONLY
 * cryptographically-verified receipts (HMAC recomputed against the signing key)
 * plus the verdict headline (verified vs quarantined-with-reason). Forged/legacy
 * rows are counted in stats.by_reason but never rendered. Reads the service_role
 * view — this is the surface a public trust page should proxy.
 */
router.get('/verified', async (req: Request, res: Response) => {
  const rawLimit = Number((req.query.limit as string) ?? '50');
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  const [stats, receipts] = await Promise.all([
    verifiedReceiptStats(db),
    listVerifiedReceipts(db, limit),
  ]);
  return res.json({ stats, receipts, count: receipts.length });
});

router.post('/', async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const agent_id = typeof b.agent_id === 'string' ? b.agent_id.trim() : '';
  const tool_name = typeof b.tool_name === 'string' ? b.tool_name.trim() : '';
  const input_hash = typeof b.input_hash === 'string' ? b.input_hash.toLowerCase() : '';
  const output_hash = typeof b.output_hash === 'string' ? b.output_hash.toLowerCase() : '';
  const vertical = typeof b.vertical === 'string' && b.vertical.trim() ? b.vertical.trim() : 'trustshell';
  const tool_version = typeof b.tool_version === 'string' ? b.tool_version : null;
  const execution_time_ms = typeof b.execution_time_ms === 'number' ? b.execution_time_ms : null;

  if (!agent_id || !tool_name) {
    return res.status(400).json({ error: 'agent_id and tool_name are required' });
  }
  if (!HEX64.test(input_hash) || !HEX64.test(output_hash)) {
    return res.status(400).json({
      error: 'input_hash and output_hash must each be 64 lowercase hex chars (sha256 of the tool input/output)',
    });
  }

  const id = await writeToolReceipt(db, {
    vertical,
    agentId: agent_id,
    toolName: tool_name,
    inputHash: input_hash,
    outputHash: output_hash,
    toolVersion: tool_version,
    executionTimeMs: execution_time_ms,
  });

  if (!id) {
    // writeToolReceipt logs the reason (bad hash already rejected above; here it is an
    // RPC/DB failure, e.g. an unprovisioned signing key). 502: the mint, not the request, failed.
    return res.status(502).json({ error: 'receipt_mint_failed', message: 'write_tool_receipt did not return an id' });
  }
  return res.status(201).json({ receipt_id: id, vertical, agent_id, tool_name });
});

export default router;
