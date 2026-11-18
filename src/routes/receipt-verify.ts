/**
 * POST /api/v1/receipt/verify
 * Returns the receipt id and the family verdicts.
 * Claim text is not part of the body. This route does not insert.
 */
import { Router, type Request, type Response } from 'express';
import { verifyReceiptResponse } from '../hal/verify-receipt-response';
import { checkHalReceipt } from '../hal/signed-verdict-receipt';
import { trustedKernelReceiptSigners } from '../kernel/receipt-signing';

const router = Router();

/**
 * HAL_SIGNED_RECEIPT_VERIFY_ENABLED (exactly `true`, default off) adds `signature_check` for a body
 * carrying `signed_receipt`, checked against KERNEL_RECEIPT_TRUSTED_SIGNERS. It reads no table, so a
 * forged hal_quorum_receipts row cannot make it say verified. Off = the response is unchanged.
 */
router.post('/receipt/verify', (req: Request, res: Response): void => {
  const out = verifyReceiptResponse(req.body);
  const signed = (req.body as Record<string, unknown> | null)?.['signed_receipt'];
  if (process.env.HAL_SIGNED_RECEIPT_VERIFY_ENABLED === 'true' && signed !== undefined) {
    res.status(200).json({ ...out, signature_check: checkHalReceipt(signed, trustedKernelReceiptSigners()) });
    return;
  }
  res.status(200).json(out);
});

export default router;
