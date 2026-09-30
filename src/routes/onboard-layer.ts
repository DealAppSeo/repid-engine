/**
 * GET /api/v1/onboard/layer
 * Counted receipts map onto the same layer number.
 * A thrown read is NOT_CHECKED, never 0.
 */
import { Router, type Request, type Response } from 'express';
import { readOnboardLayer } from '../services/onboard-layer';

export type ReceiptCounter = () => Promise<number | 'NOT_CHECKED'>;

export function createOnboardLayerRouter(countReceipts: ReceiptCounter = async () => 'NOT_CHECKED') {
  const router = Router();
  router.get('/onboard/layer', async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json(await readOnboardLayer(countReceipts));
  });
  return router;
}

export default createOnboardLayerRouter();
