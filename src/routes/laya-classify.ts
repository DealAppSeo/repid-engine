/**
 * GET and POST /api/v1/route-hint (and the original /api/v1/laya/classify, kept working)
 * Local text route. The body is route and latency_ms.
 *
 * NOT THE LAYA MODEL. This is a keyword-and-length rule (src/laya/classify.ts) and calls no
 * model. The Convai Laya model shares the name and is wired nowhere, so the route got a name
 * that says what it does (Sean, 2026-10-03: "rename as an alias"). The old path stays for
 * every existing caller; new callers use /route-hint.
 * A request with no text asks. This handler does not call a model, a vendor, or a quorum.
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

function respond(req: Request, res: Response): void {
  res.status(200).json(layaClassify(textOf(req.body)));
}

router.get('/route-hint', respond);
router.post('/route-hint', respond);
// Original name, kept working for existing callers. Same handler, same response.
router.get('/laya/classify', respond);
router.post('/laya/classify', respond);

export default router;
