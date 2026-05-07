import { Router, Request, Response } from 'express';
import { openApiSpec } from '../api/openapi';
import { config } from '../config';

const router = Router();

router.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

router.get('/.well-known/ai-plugin.json', (_req: Request, res: Response) => {
  res.json({
    schema_version: "v1",
    name_for_human: "HyperDAG RepID",
    name_for_model: "hyperdag_repid",
    description_for_human: "Trust scoring and verifiable reputation for AI agents.",
    description_for_model: "Lookup or register AI agents with verifiable trust scores. RepID provides Social Proof for AI agents via HAL evaluations and on-chain proofs.",
    api: {
      type: "openapi",
      url: "https://repid-engine-production.up.railway.app/openapi.json"
    },
    auth: { type: "user_http", authorization_type: "bearer" },
    contact_email: "support@repid.dev",
    legal_info_url: "https://repid.dev/ethics"
  });
});

export default router;
