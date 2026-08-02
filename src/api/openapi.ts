export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "HyperDAG RepID Engine API",
    description: "Trust scoring, verifiable reputation (ERC-8004), and agentic payment (x402) infrastructure for AI agents.",
    version: "1.0.0",
    contact: {
      url: "https://repid.dev"
    },
    license: {
      name: "Apache-2.0"
    }
  },
  servers: [
    {
      url: "https://repid-engine-production.up.railway.app",
      description: "Production"
    }
  ],
  tags: [
    { name: "Agents", description: "Register and inspect AI agents" },
    { name: "HAL & Scoring", description: "Hallucination evaluation and reputation scoring" },
    { name: "ERC-8004 & ZKP", description: "On-chain identity and zero-knowledge reputation proofs" },
    { name: "Reponomics & Staking", description: "Economic skin-in-the-game and betting protocols" },
    { name: "x402 Payments", description: "Agent-to-agent micropayment and tipping protocols" },
    { name: "Bounties", description: "Work coordination and verification" },
    { name: "Audit & Hashkey", description: "Merkle-anchored audit logs and immutable hashes" },
    { name: "Receipts", description: "Verifiable trust receipts and content-addressable history" }
  ],
  paths: {
    "/api/v1/agents/register": {
      post: {
        tags: ["Agents"],
        summary: "Register an external agent",
        description: "Registers a new AI agent and returns an API key.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/AgentRegistrationRequest" } } }
        },
        responses: {
          "200": { description: "Successful registration", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentRegistrationResponse" } } } }
        }
      }
    },
    "/api/v1/agents/{id}/card": {
      get: {
        tags: ["Agents"],
        summary: "Get agent discovery card",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Agent card details", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentCard" } } } } }
      }
    },
    "/api/v1/agents/{id}/keys": {
      get: {
        tags: ["Agents"],
        summary: "List agent API keys",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "List of keys" } }
      },
      post: {
        tags: ["Agents"],
        summary: "Issue new API key",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string" } } } } } }
        },
        responses: { "201": { description: "Key issued" } }
      }
    },
    "/api/v1/llm/complete": {
      post: {
        tags: ["HAL & Scoring"],
        summary: "LLM completion with HAL evaluation",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LLMCompleteRequest" } } }
        },
        responses: { "200": { description: "Successful completion" } }
      }
    },
    "/api/v1/agents-external/{id}/score-event": {
      post: {
        tags: ["HAL & Scoring"],
        summary: "Submit a score event",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ScoreEventRequest" } } }
        },
        responses: { "200": { description: "Score event processed" } }
      }
    },
    "/api/v1/hal/stats": {
      get: {
        tags: ["HAL & Scoring"],
        summary: "Get live HAL production stats",
        responses: { "200": { description: "HAL performance metrics" } }
      }
    },
    "/api/v1/metrics": {
      get: {
        tags: ["HAL & Scoring"],
        summary: "Get system-wide metrics",
        responses: { "200": { description: "Network and performance metrics" } }
      }
    },
    "/api/v1/repid/{agent_id}": {
      get: {
        tags: ["ERC-8004 & ZKP"],
        summary: "Get agent RepID and tier",
        parameters: [{ name: "agent_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "RepID details" } }
      }
    },
    "/api/v1/repid/{agent_id}/history": {
      get: {
        tags: ["ERC-8004 & ZKP"],
        summary: "Get agent RepID history",
        parameters: [
          { name: "agent_id", in: "path", required: true, schema: { type: "string" } },
          { name: "since", in: "query", schema: { type: "string", format: "date-time" } }
        ],
        responses: { "200": { description: "RepID event trail" } }
      }
    },
    "/api/v1/repid/verify": {
      post: {
        tags: ["ERC-8004 & ZKP"],
        summary: "Verify RepID attestation",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Verification result" } }
      }
    },
    "/api/v1/erc8004/validate/{agent_id}": {
      get: {
        tags: ["ERC-8004 & ZKP"],
        summary: "ERC-8004 Identity Validation",
        parameters: [{ name: "agent_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ERC-8004 validation" } }
      }
    },
    "/api/v1/prove-repid": {
      post: {
        tags: ["ERC-8004 & ZKP"],
        summary: "Generate ZK proof of RepID",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ZKProofRequest" } } } },
        responses: { "200": { description: "Proof generated" } }
      }
    },
    "/api/v1/stake/deposit/message": {
      get: {
        tags: ["Reponomics & Staking"],
        summary: "Exact text to sign when claiming a real deposit",
        description:
          "Returns the message a wallet must sign to credit an on-chain deposit. Fetch it rather " +
          "than reconstructing the string client-side: any drift becomes a bad signature instead " +
          "of a subtly wrong prompt shown to someone about to sign. Public, read-only.",
        parameters: [
          { name: "wallet", in: "query", required: true, schema: { type: "string" } },
          { name: "amount", in: "query", required: true, schema: { type: "string" }, description: "USDC smallest unit (6 decimals)" },
          { name: "tx_hash", in: "query", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Message to sign" }, "400": { description: "Missing parameter" } }
      }
    },
    "/api/v1/stake/deposit": {
      post: {
        tags: ["Reponomics & Staking"],
        summary: "Deposit stake for a builder",
        description:
          "Authorization scales with what is being credited. SIMULATED stake (no tx_hash) requires " +
          "a full-account session (`Authorization: Bearer <login_token>`) for that same account, or " +
          "an operator API key. A REAL deposit (tx_hash present) additionally requires `signature` " +
          "— an EIP-191 personal_sign over GET /api/v1/stake/deposit/message. A session alone is " +
          "never enough for a real deposit: a session proves an email login, a deposit credits " +
          "value against a wallet.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["builder_address", "amount"],
                properties: {
                  builder_address: { type: "string" },
                  amount: { type: "string", description: "USDC smallest unit (6 decimals)" },
                  tx_hash: { type: "string", description: "Base Sepolia tx of the USDC transfer into escrow. Omit for simulated stake." },
                  signature: { type: "string", description: "Required whenever tx_hash is present." }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Deposit recorded (response carries `authorized_by`: session | wallet_signature | operator)" },
          "400": { description: "Bad request, or on-chain verification failed" },
          "401": { description: "Not authorized to credit this account (no_credential / invalid_session / not_your_account / signature_required / bad_signature)" },
          "404": { description: "No account registered under that address" }
        }
      }
    },
    "/api/v1/bet/place": {
      post: {
        tags: ["Reponomics & Staking"],
        summary: "Place a linked bet",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Bet placed" } }
      }
    },
    "/api/v1/tip/request": {
      post: {
        tags: ["x402 Payments"],
        summary: "Create an x402 tip request",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "402": { description: "Payment required" } }
      }
    },
    "/api/v1/tip/deliver/{tipId}": {
      post: {
        tags: ["x402 Payments"],
        summary: "Deliver tip with x-payment header",
        parameters: [
          { name: "tipId", in: "path", required: true, schema: { type: "string" } },
          { name: "X-PAYMENT", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Tip delivered" } }
      }
    },
    "/bounties": {
      get: {
        tags: ["Bounties"],
        summary: "List active bounties",
        responses: { "200": { description: "List of bounties" } }
      },
      post: {
        tags: ["Bounties"],
        summary: "Post a new bounty",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Bounty" } } } },
        responses: { "201": { description: "Bounty created" } }
      }
    },
    "/bounties/{id}": {
      get: {
        tags: ["Bounties"],
        summary: "Get bounty detail",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Bounty details" } }
      }
    },
    "/bounties/{id}/claim": {
      post: {
        tags: ["Bounties"],
        summary: "Claim a bounty",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Claimed" } }
      }
    },
    "/api/v1/audit/verify": {
      get: {
        tags: ["Audit & Hashkey"],
        summary: "Verify Merkle audit chain",
        responses: { "200": { description: "Verification results" } }
      }
    },
    "/hashkey": {
      get: {
        tags: ["Audit & Hashkey"],
        summary: "Get HashKey chain status",
        responses: { "200": { description: "Status details" } }
      }
    },
    "/hashkey/anchor/{agentId}": {
      get: {
        tags: ["Audit & Hashkey"],
        summary: "Generate on-chain anchor",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Anchor metadata" } }
      }
    },
    "/api/v1/receipts": {
      get: {
        tags: ["Receipts"],
        summary: "List agent receipts",
        parameters: [{ name: "agentId", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Receipt trail" } }
      },
      post: {
        tags: ["Receipts"],
        summary: "Issue a trust receipt",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Receipt issued" } }
      }
    },
    "/api/v1/receipts/{receiptId}": {
      get: {
        tags: ["Receipts"],
        summary: "Get receipt JSON",
        parameters: [{ name: "receiptId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Receipt content" } }
      }
    },
    "/api/v1/network/status": {
      get: {
        tags: ["Audit & Hashkey"],
        summary: "Get global network status",
        responses: { "501": { description: "Not implemented" } }
      }
    }
  },
  components: {
    schemas: {
      AgentRegistrationRequest: { type: "object", properties: { agent_name: { type: "string" }, description: { type: "string" }, constitution_text: { type: "string" } }, required: ["agent_name"] },
      AgentRegistrationResponse: { type: "object", properties: { agent_id: { type: "string", format: "uuid" }, api_key: { type: "string" } } },
      AgentCard: { type: "object", properties: { name: { type: "string" }, repid: { type: "number" }, tier: { type: "string" }, total_score_events: { type: "number" } } },
      LLMCompleteRequest: { type: "object", properties: { prompt: { type: "string" }, agent_id: { type: "string" } }, required: ["prompt"] },
      ScoreEventRequest: { type: "object", properties: { prompt: { type: "string" }, answer: { type: "string" } }, required: ["prompt", "answer"] },
      ZKProofRequest: { type: "object", properties: { agent_id: { type: "string" }, requester_pubkey: { type: "string" }, requested_tier: { type: "string" } }, required: ["agent_id", "requester_pubkey", "requested_tier"] },
      Bounty: { type: "object", properties: { title: { type: "string" }, reward_amount: { type: "number" } }, required: ["title"] }
    },
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }
  }
};
