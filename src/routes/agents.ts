import { Router, Request, Response } from 'express';
const router = Router();

router.get('/agents', async (req: Request, res: Response) => {
  res.json({ status: 'coming_soon', sprint: 8, docs: 'trustrepid.dev' });
});

router.post('/agents', async (req: Request, res: Response) => {
  res.json({ status: 'coming_soon', sprint: 8, docs: 'trustrepid.dev' });
});

export default router;
