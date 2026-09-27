/**
 * POST /api/v1/human/bind/preview
 * Empty bind is 401. A complete body names the wallet and the agent.
 * applied stays false. This route does not insert a binding.
 */
import { Router, type Request, type Response } from 'express';
import { previewBind } from '../services/bind-preview';

const router = Router();

router.post('/human/bind/preview', (req: Request, res: Response): void => {
  const preview = previewBind(req.body);
  res.status(preview.status).json(preview);
});

export default router;
