/**
 * POST /api/v1/laya/classify
 * Local text route. The body is route and latency_ms.
 * This handler does not call a model, a vendor, or a quorum.
 */
import { Router, type Request, type Response } from 'express';
import { classify, type LayaRoute } from '../laya/classify';

const router = Router();

export function layaClassify(text: string): { route: LayaRoute; latency_ms: number } {
  const out = classify(text);
  return { route: out.route, latency_ms: out.latency_ms };
}

function textOf(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const text = (body as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

router.post('/laya/classify', (req: Request, res: Response): void => {
  res.status(200).json(layaClassify(textOf(req.body)));
});

export default router;
