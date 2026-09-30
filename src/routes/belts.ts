/**
 * GET /api/v1/belts
 * Public belt ids only. Each row is an id.
 */
import { Router, type Request, type Response } from 'express';

export const PUBLIC_BELT_IDS = ['cmo', 'cfo', 'cto'] as const;

export function publicBelts(): { belts: { id: string }[] } {
  return { belts: PUBLIC_BELT_IDS.map((id) => ({ id })) };
}

const router = Router();

router.get('/belts', (_req: Request, res: Response): void => {
  res.status(200).json(publicBelts());
});

export default router;
