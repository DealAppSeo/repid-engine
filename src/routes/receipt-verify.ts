/**
 * POST /api/v1/receipt/verify
 * Returns the receipt id and the family verdicts.
 * Claim text is not part of the body. This route does not insert.
 */
import { Router, type Request, type Response } from 'express';
import { verifyReceiptResponse } from '../hal/verify-receipt-response';

const router = Router();

router.post('/receipt/verify', (req: Request, res: Response): void => {
  res.status(200).json(verifyReceiptResponse(req.body));
});

export default router;
