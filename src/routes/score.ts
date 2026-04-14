import { Router, Request, Response } from 'express';
const router = Router();

router.post('/score', async (req: Request, res: Response) => {
  res.json({ status: 'coming_soon', sprint: 7, docs: 'trustrepid.dev' });
});

export default router;
