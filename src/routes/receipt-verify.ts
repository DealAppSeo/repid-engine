/**
 * POST /api/v1/receipt/verify
 * Returns the receipt id and the family verdicts.
 * Claim text is not part of the body. This route does not insert.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { trustedClientIp } from '../middleware/client-ip';
import { verifyReceiptResponse } from '../hal/verify-receipt-response';
import { checkHalReceipt } from '../hal/signed-verdict-receipt';
import { trustedKernelReceiptSigners } from '../kernel/receipt-signing';

const router = Router();

/**
 * HAL_SIGNED_RECEIPT_VERIFY_ENABLED (exactly `true`, default off) adds `signature_check` for a body
 * carrying `signed_receipt`, checked against KERNEL_RECEIPT_TRUSTED_SIGNERS. It reads no table, so a
 * forged hal_quorum_receipts row cannot make it say verified. Off = the response is unchanged.
 */
// Per-IP brake: the signature check is CPU work an anonymous caller can ask for. CodeQL js/missing-rate-limiting.
const verifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

router.post('/receipt/verify', verifyLimiter, (req: Request, res: Response): void => {
  const out = verifyReceiptResponse(req.body);
  const signed = (req.body as Record<string, unknown> | null)?.['signed_receipt'];
  if (process.env.HAL_SIGNED_RECEIPT_VERIFY_ENABLED === 'true' && signed !== undefined) {
    res.status(200).json({ ...out, signature_check: checkHalReceipt(signed, trustedKernelReceiptSigners()) });
    return;
  }
  res.status(200).json(out);
});

export default router;
