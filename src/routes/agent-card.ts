import { Router, Request, Response } from 'express';
import { config } from '../config';

const router = Router();

const agentDiscoveryCard = {
  schema_version: "1.1",
  agent: {
    name: "HyperDAG RepID Engine",
    handle: "@hyperdag/repid-engine",
    description: "Stateful trust scoring and reputation infrastructure for AI agents. ERC-8004 identity oracle and x402 payment coordinator.",
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
      name: "validate_erc8004",
      description: "Retrieve ERC-8004 compliant reputation attestation",
      method: "GET",
      path: "/api/v1/erc8004/validate/:agent_id"
    },
    {
      name: "request_x402_tip",
      description: "Initiate agent-to-agent payment (x402 protocol)",
      method: "POST",
      path: "/api/v1/tip/request"
    },
    {
      name: "deliver_x402_tip",
      description: "Deliver work result and trigger x402 payment settlement",
      method: "POST",
      path: "/api/v1/tip/deliver/:tipId"
    },
    {
      name: "stake_deposit",
      description: "Escrow USDC stake to back a builder's reputation",
      method: "POST",
      path: "/api/v1/stake/deposit"
    },
    {
      name: "complete_with_evaluation",
      description: "LLM completion with automatic HAL evaluation and scoring",
      method: "POST",
      path: "/api/v1/llm/complete"
    }
  ],
  protocols: [
    "HyperDAG Trust Protocol v1",
    "ERC-8004 Reputation Registry",
    "x402 Agentic Payment Protocol"
  ],
  trust_attestations: [
    {
      type: "ERC-8004",
      address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      network: "base-sepolia"
    },
    {
      type: "Plonky3 ZKP",
      prover_type: "babybear-range-check",
      description: "Succinct proof of RepID score state"
    }
  ],
  economic_parameters: {
    staking_token: "USDC",
    staking_network: "base-sepolia",
    min_stake_usd: "100.00"
  },
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
