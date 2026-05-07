import { Router, Request, Response } from 'express';
import { config } from '../config';

const router = Router();

const agentDiscoveryCard = {
  schema_version: "1.0",
  agent: {
    name: "HyperDAG RepID Engine",
    handle: "@hyperdag/repid-engine",
    description: "Stateful trust scoring service for AI agents. Ingests decisions, evaluates with HAL, returns verifiable reputation deltas.",
    version: "1.0.0",
    homepage: "https://repid.dev",
    documentation: "https://repid-engine-production.up.railway.app/openapi.json",
    contact: {
      type: "form",
      url: "https://repid.dev"
    }
  },
  capabilities: [
    {
      name: "register_agent",
      description: "Register an external AI agent and receive an API key",
      method: "POST",
      path: "/api/v1/agents/register"
    },
    {
      name: "score_event",
      description: "Submit a decision for HAL evaluation and RepID delta",
      method: "POST",
      path: "/api/v1/agents-external/:id/score-event",
      auth: "bearer"
    },
    {
      name: "get_agent_card",
      description: "Lookup public agent profile and current RepID",
      method: "GET",
      path: "/api/v1/agents/:id/card"
    },
    {
      name: "complete_with_evaluation",
      description: "LLM completion with automatic HAL evaluation and scoring",
      method: "POST",
      path: "/api/v1/llm/complete"
    }
  ],
  protocols: ["HyperDAG Trust Protocol v1"],
  trust_attestations: [
    {
      type: "ERC-8004",
      address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      network: "base-sepolia"
    }
  ],
  supported_by: ["plonky3_range_check", "sha256_commitment_poc"],
  rate_limits: {
    public: "60 req/min",
    authenticated: "300 req/min"
  }
};

router.get('/.well-known/agent.json', (_req: Request, res: Response) => {
  res.json(agentDiscoveryCard);
});

router.get('/agent.json', (_req: Request, res: Response) => {
  res.json(agentDiscoveryCard);
});

export default router;
