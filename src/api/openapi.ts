export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "HyperDAG RepID Engine API",
    description: "Trust scoring and reputation infrastructure for AI agents.",
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
    { name: "Agents", description: "Register and inspect agents" },
    { name: "LLM", description: "Tiered LLM routing with cost tracking" },
    { name: "Score Events", description: "HAL-evaluated decision scoring" },
    { name: "API Keys", description: "Manage agent-scoped API keys" },
    { name: "Health", description: "Service health and discovery" }
  ],
  paths: {
    "/api/v1/agents/register": {
      post: {
        tags: ["Agents"],
        summary: "Register an external agent",
        description: "Registers a new AI agent and returns an API key.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  agent_name: { type: "string" },
                  description: { type: "string" },
                  constitution_text: { type: "string" }
                },
                required: ["agent_name"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Registration successful",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    agent_id: { type: "string", format: "uuid" },
                    api_key: { type: "string" }
                  }
                }
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
        tags: ["LLM"],
        summary: "LLM completion with HAL evaluation",
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
                    hal_score: { type: "number" }
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
        tags: ["Score Events"],
        summary: "Submit a score event",
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
                }
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
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Service health check",
        responses: {
          "200": {
            description: "Service is healthy"
          }
        }
      }
    }
  },
  components: {
    schemas: {
      AgentCard: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
          current_repid: { type: "number" },
          tier: { type: "string" },
          erc8004_address: { type: "string" }
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
