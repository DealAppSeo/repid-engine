/**
 * POST /api/v1/proof/verify
 *
 * Existing plonky3_range_check verifier. No minter. No chain write.
 */
import { Router, type Request, type Response } from 'express';
import { verifyRangeCheck } from '../zkp/range-check-verify';

const router = Router();

function verifyHttp(req: Request, res: Response): void {
  const proofBytes = req.body?.proof_bytes;
  const statement = req.body?.statement;
  if (typeof proofBytes !== 'string' || !proofBytes || statement == null || typeof statement !== 'object' || Array.isArray(statement)) {
    res.status(400).json({
      verified: false,
      scheme: 'plonky3_range_check',
      error: 'proof_bytes and statement are required',
    });
    return;
  }
  res.json(verifyRangeCheck(proofBytes, statement as Record<string, unknown>));
}

router.get('/proof/verify', verifyHttp);
router.post('/proof/verify', verifyHttp);

export default router;
