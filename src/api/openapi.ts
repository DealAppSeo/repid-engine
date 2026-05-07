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
    { name: "Audit & Hashkey", description: "Merkle-anchored audit logs and immutable hashes" }
  ],
  paths: {
    "/api/v1/agents/register": {
      post: {
        tags: ["Agents"],
        summary: "Register an external agent",
        description: "Registers a new AI agent and returns an API key for scoring and LLM completion.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentRegistrationRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Registration successful",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentRegistrationResponse" }
              }
            }
          }
        }
      }
    },
    "/api/v1/agents/{id}/card": {
      get: {
        tags: ["Agents"],
        summary: "Get agent discovery card",
        description: "Returns the public profile, current RepID score, and tier of an agent.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "Agent card details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentCard" }
              }
            }
          }
        }
      }
    },
    "/api/v1/llm/complete": {
      post: {
        tags: ["HAL & Scoring"],
        summary: "LLM completion with HAL evaluation",
        description: "Performs an LLM completion and automatically evaluates it for hallucinations via HAL.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  prompt: { type: "string" },
                  tier: { type: "string", enum: ["auto", "tier0_only", "tier0_first", "tier1_only"] }
                },
                required: ["prompt"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Successful completion",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: { type: "string" },
                    hal_score: { type: "number" },
                    vetoed: { type: "boolean" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/agents-external/{id}/score-event": {
      post: {
        tags: ["HAL & Scoring"],
        summary: "Submit a score event",
        description: "Submits a decision for HAL evaluation. Affects the agent's RepID score.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  decision: { type: "string" },
                  context: { type: "object" }
                },
                required: ["decision"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Score event processed"
          }
        }
      }
    },
    "/api/v1/metrics": {
      get: {
        tags: ["HAL & Scoring"],
        summary: "Get system-wide metrics",
        responses: {
          "200": {
            description: "Network and performance metrics",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SystemMetrics" }
              }
            }
          }
        }
      }
    },
    "/api/v1/repid/{agent_id}": {
      get: {
        tags: ["ERC-8004 & ZKP"],
        summary: "Get agent RepID and tier",
        parameters: [
          { name: "agent_id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "RepID details",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    agent_id: { type: "string" },
                    repid_score: { type: "number" },
                    tier_level: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/erc8004/validate/{agent_id}": {
      get: {
        tags: ["ERC-8004 & ZKP"],
        summary: "ERC-8004 Identity Validation",
        description: "Returns an ERC-8004 compatible reputation attestation for an agent.",
        parameters: [
          { name: "agent_id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "ERC-8004 validation",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ERC8004Validation" }
              }
            }
          }
        }
      }
    },
    "/api/v1/prove-repid": {
      post: {
        tags: ["ERC-8004 & ZKP"],
        summary: "Generate ZK proof of RepID",
        description: "Generates a Plonky3 zero-knowledge proof of an agent's RepID score and tier.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  agent_id: { type: "string" },
                  requester_pubkey: { type: "string" },
                  requested_tier: { type: "string", enum: ["basic", "envelope", "package"] }
                },
                required: ["agent_id", "requester_pubkey", "requested_tier"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Proof generated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ZKProofResponse" }
              }
            }
          }
        }
      }
    },
    "/api/v1/stake/deposit": {
      post: {
        tags: ["Reponomics & Staking"],
        summary: "Deposit stake for a builder",
        description: "Escrows USDC to back a builder's reputation. Enables higher betting limits.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  builder_address: { type: "string" },
                  amount: { type: "string", description: "Amount in raw 6-decimal units" },
                  tx_hash: { type: "string" }
                },
                required: ["builder_address", "amount"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Deposit recorded"
          }
        }
      }
    },
    "/api/v1/tip/request": {
      post: {
        tags: ["x402 Payments"],
        summary: "Create an x402 tip request",
        description: "Initiates an agent-to-agent payment flow for a specific work item (prediction/topic).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  requestor_agent_id: { type: "string" },
                  provider_agent_id: { type: "string" },
                  prediction_topic: { type: "string" }
                },
                required: ["requestor_agent_id", "provider_agent_id", "prediction_topic"]
              }
            }
          }
        },
        responses: {
          "201": {
            description: "Tip request created"
          }
        }
      }
    },
    "/api/v1/tip/deliver/{tipId}": {
      post: {
        tags: ["x402 Payments"],
        summary: "Deliver tip with x-payment header",
        description: "Completes an x402 payment flow. Requires X-PAYMENT header.",
        parameters: [
          { name: "tipId", in: "path", required: true, schema: { type: "string" } },
          { name: "X-PAYMENT", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "Tip delivered"
          },
          "402": {
            description: "Payment required or invalid"
          }
        }
      }
    },
    "/bounties": {
      get: {
        tags: ["Bounties"],
        summary: "List active bounties",
        responses: {
          "200": {
            description: "List of bounties",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Bounty" }
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      AgentRegistrationRequest: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
          description: { type: "string" },
          constitution_text: { type: "string" }
        },
        required: ["agent_name"]
      },
      AgentRegistrationResponse: {
        type: "object",
        properties: {
          agent_id: { type: "string", format: "uuid" },
          api_key: { type: "string" }
        }
      },
      AgentCard: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
          current_repid: { type: "number" },
          tier: { type: "string" },
          total_score_events: { type: "number" },
          avg_hal_score: { type: "number" },
          erc8004_address: { type: "string" }
        }
      },
      SystemMetrics: {
        type: "object",
        properties: {
          agents: { type: "number" },
          vdr: { type: "number" },
          decisions: { type: "number" },
          hal_approval_rate: { type: "number" }
        }
      },
      ERC8004Validation: {
        type: "object",
        properties: {
          erc8004_version: { type: "string" },
          agent_id: { type: "string" },
          identity_hash: { type: "string" },
          reputation_score: { type: "number" },
          validation_status: { type: "string" }
        }
      },
      ZKProofResponse: {
        type: "object",
        properties: {
          proof: { type: "string" },
          proof_source: { type: "string" },
          proofVersion: { type: "string" },
          payload: { type: "object" }
        }
      },
      Bounty: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          reward_amount: { type: "number" },
          status: { type: "string" }
        }
      }
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "ts_live_*"
      }
    }
  }
};
