/**
 * POST /api/v1/human/unbind/preview
 * Empty unbind is 401. A complete body names the wallet and the agent.
 * applied stays false. This route does not insert or delete a binding.
 */
import { Router, type Request, type Response } from 'express';
import { previewUnbind } from '../services/unbind-shadow';

const router = Router();

router.post('/human/unbind/preview', (req: Request, res: Response): void => {
  const preview = previewUnbind(req.body);
  res.status(preview.status).json(preview);
});

export default router;
