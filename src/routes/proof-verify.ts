/**
 * POST /api/v1/proof/verify
 *
 * Existing plonky3_range_check verifier. No minter. No chain write.
 */
import { Router, type Request, type Response } from 'express';
import { verifyRangeCheck } from '../zkp/range-check-verify';

const router = Router();

router.post('/proof/verify', (req: Request, res: Response): void => {
  const proofBytes = req.body?.proof_bytes;
  const statement = req.body?.statement;
  if (typeof proofBytes !== 'string' || !proofBytes || statement == null || typeof statement !== 'object') {
    res.status(400).json({
      verified: false,
      scheme: 'plonky3_range_check',
      error: 'proof_bytes and statement are required',
    });
    return;
  }
  res.json(verifyRangeCheck(proofBytes, statement as Record<string, unknown>));
});

export default router;
