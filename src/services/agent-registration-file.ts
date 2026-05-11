// ERC-8004 agent registration file generator.
//
// The "agent registration file" is the off-chain JSON content served at
// the agent's `agentURI` (the tokenURI of its IdentityRegistry token).
// Any ERC-8004-aware indexer or wallet can fetch this URL to discover
// the agent's services, name, image, and back-references to the
// on-chain identity.
//
// Spec: github.com/erc-8004/erc-8004-contracts — section "Agent
//       registration file" (the off-chain JSON tied to tokenURI).
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AgentRegistrationFile {
  type: 'erc8004-registration-v1';
  name: string;
  description: string;
  image: string;
  services: Array<{
    type: string;
    url: string;
    description?: string;
    [k: string]: unknown;
  }>;
  registrations: Array<{
    agentRegistry: string; // CAIP-2 format: eip155:<chainId>:<contract>
    agentId: string;
  }>;
  supportedTrust: string[];
  hyperdag?: {
    current_repid: number;
    tier: string;
    verifier_package: string;
    verify_url: string;
    proof_endpoint: string;
  };
}

export interface AgentRegistrationContext {
  agent_id: string;
  agent_name: string;
  description: string;
  current_repid: number;
  tier: string;
  erc8004_token_id: string;
  chain_id: number;
  identity_registry_address: string;
}

const CAIP2_PREFIX_BY_CHAIN: Record<number, string> = {
  8453: 'eip155:8453',     // Base Mainnet
  84532: 'eip155:84532',   // Base Sepolia
  1: 'eip155:1',           // Ethereum
  11155111: 'eip155:11155111', // Ethereum Sepolia
  137: 'eip155:137',       // Polygon
  42161: 'eip155:42161',   // Arbitrum One
  421614: 'eip155:421614', // Arbitrum Sepolia
};

const CANONICAL_IDENTITY_REGISTRY_TESTNET =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e';

const BASE_ENGINE_URL =
  process.env.PUBLIC_ENGINE_BASE_URL ||
  'https://repid-engine-production.up.railway.app';

export function generateRegistrationFile(
  ctx: AgentRegistrationContext
): AgentRegistrationFile {
  const caipPrefix =
    CAIP2_PREFIX_BY_CHAIN[ctx.chain_id] || `eip155:${ctx.chain_id}`;
  const agentRegistry = `${caipPrefix}:${ctx.identity_registry_address}`;

  return {
    type: 'erc8004-registration-v1',
    name: ctx.agent_name,
    description: ctx.description,
    image: `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}/avatar.png`,
    services: [
      {
        type: 'http',
        url: `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}`,
        description: 'HyperDAG agent state endpoint',
      },
      {
        type: 'http-verify',
        url: `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}/verify`,
        description: 'STARK-verifiable RepID proof endpoint',
      },
      {
        type: 'http-recall',
        url: `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}/recall`,
        description: 'Graph RAG memory recall surface',
      },
      {
        type: 'http-card',
        url: `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}/card`,
        description: 'Public agent card (no private fields)',
      },
      {
        type: 'http-feedback',
        url: `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}/reputation/payload.json`,
        description: 'Latest reputation feedback payload (off-chain content for giveFeedback)',
      },
    ],
    registrations: [{ agentRegistry, agentId: ctx.erc8004_token_id }],
    supportedTrust: ['reputation'],
    hyperdag: {
      current_repid: ctx.current_repid,
      tier: ctx.tier,
      verifier_package: '@hyperdag/proof-verifier@^0.1.0',
      verify_url: `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}/verify`,
      proof_endpoint: `${BASE_ENGINE_URL}/api/v1/repid/proof/:job_id`,
    },
  };
}

/**
 * Fetches an agent from Supabase and renders its registration file.
 * Returns `null` if the agent is not minted (no erc8004_token_id).
 * Mounted at GET /api/v1/agents/:id/registration.json.
 */
export async function fetchAndGenerateRegistrationFile(
  supabase: SupabaseClient,
  agentId: string,
  options: { chain_id?: number; registry_address?: string } = {}
): Promise<AgentRegistrationFile | null> {
  const { data: agent, error } = await supabase
    .from('repid_agents')
    .select(
      'id, agent_name, description, current_repid, tier, erc8004_token_id, mint_chain_id, erc8004_address'
    )
    .eq('id', agentId)
    .single();

  if (error || !agent) return null;
  if (!agent.erc8004_token_id) return null;

  const resolvedChainId =
    options.chain_id ?? agent.mint_chain_id ?? 84532;

  // Prefer the explicit option, then the DB-stored contract address (only
  // if it looks like a contract — APM-style legacy values may be wallets).
  // Fall back to the canonical testnet vanity address.
  let resolvedRegistry =
    options.registry_address ?? CANONICAL_IDENTITY_REGISTRY_TESTNET;
  if (
    !options.registry_address &&
    typeof agent.erc8004_address === 'string' &&
    agent.erc8004_address.length === 42 &&
    agent.erc8004_address.toLowerCase().startsWith('0x8004')
  ) {
    resolvedRegistry = agent.erc8004_address;
  }

  return generateRegistrationFile({
    agent_id: agent.id,
    agent_name: agent.agent_name,
    description:
      agent.description ||
      `HyperDAG-anchored AI agent ${agent.agent_name}`,
    current_repid: agent.current_repid || 0,
    tier: agent.tier || 'PROBATIONARY',
    erc8004_token_id: agent.erc8004_token_id,
    chain_id: resolvedChainId,
    identity_registry_address: resolvedRegistry,
  });
}
