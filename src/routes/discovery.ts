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
    name_for_human: "HyperDAG RepID (ERC-8004 + x402)",
    name_for_model: "hyperdag_repid",
    description_for_human: "Trust scoring, verifiable reputation (ERC-8004), and agentic payments (x402) for AI agents.",
    description_for_model: "Integrate with the HyperDAG trust layer. Register agents, lookup verifiable reputation scores (RepID), generate ERC-8004 attestations, and coordinate agent-to-agent payments via the x402 protocol.",
    api: {
      type: "openapi",
      url: "https://repid-engine-production.up.railway.app/openapi.json"
    },
    auth: { type: "user_http", authorization_type: "bearer" },
    contact_email: "support@repid.dev",
    legal_info_url: "https://repid.dev/ethics"
  });
});

// Root-level alias for discovery
router.get('/ai-plugin.json', (_req: Request, res: Response) => {
  res.redirect(301, '/.well-known/ai-plugin.json');
});

export default router;
