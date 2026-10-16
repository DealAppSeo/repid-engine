// ERC-8004 agent registration file generator.
//
// The "agent registration file" is the off-chain JSON content served at
// the agent's `agentURI` (the tokenURI of its IdentityRegistry token).
// Any ERC-8004-aware indexer or wallet can fetch this URL to discover
// the agent's services, name, image, and back-references to the
// on-chain identity.
//
// Spec: ERC-8004 "Trustless Agents", section "Agent registration file" —
//   https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8004.md
//   (ethereum/ERCs master, last change 503591a6, 2026-01-25; status Draft).
//   "The registration file MUST have the following structure": `type` is the
//   literal https://eips.ethereum.org/EIPS/eip-8004#registration-v1; `name`,
//   `description`, `image`; `services[]` of {name, endpoint, version?};
//   `x402Support`; `active`; `registrations[]` of {agentId, agentRegistry}
//   (all mandatory, agentId a number in the spec example); `supportedTrust[]`
//   OPTIONAL. Our extras live under ONE namespaced key, `hyperdag`.
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalIdentityRegistry } from '../identity/registry-address';
import { slotStateFromHistory, type SlotState } from './registration-slots';

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export interface AgentRegistrationFile {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  image: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{
    agentId: number | string; // number per spec; string only if it would lose precision
    agentRegistry: string; // {namespace}:{chainId}:{identityRegistry}
  }>;
  supportedTrust: string[];
  hyperdag: {
    current_repid: number;
    tier: string;
    verifier_package: string;
    verify_url: string;
    proof_endpoint: string;
    slots?: SlotState; // only when REGISTRATION_SLOTS_ENABLED=true
  };
}

export interface AgentRegistrationContext {
  agent_id: string;
  agent_name: string;
  description: string;
  current_repid: number;
  tier: string;
  active: boolean;
  erc8004_token_id: string;
  chain_id: number;
  identity_registry_address: string;
  slots?: SlotState;
}

const BASE_ENGINE_URL =
  process.env.PUBLIC_ENGINE_BASE_URL ||
  'https://repid-engine-production.up.railway.app';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function slotsEnabled(): boolean {
  return (process.env.REGISTRATION_SLOTS_ENABLED || '').toLowerCase() === 'true';
}

export function generateRegistrationFile(
  ctx: AgentRegistrationContext
): AgentRegistrationFile {
  const agentUrl = `${BASE_ENGINE_URL}/api/v1/agents/${ctx.agent_id}`;
  const verifyUrl = `${BASE_ENGINE_URL}/api/v1/proof/verify`;
  const tokenNum = Number(ctx.erc8004_token_id);

  return {
    type: REGISTRATION_TYPE,
    name: ctx.agent_name,
    description: ctx.description,
    // No avatar route exists (GET .../avatar.png answered 401 live, 2026-10-16). An empty
    // image beats a URL that does not resolve.
    image: '',
    // Only endpoints an anonymous caller can reach. The old `.../agents/:id/verify` was never a
    // route; the public range-check verifier is /api/v1/proof/verify. `/agents/:id` and
    // `.../recall` need an API key (401 anonymous, 2026-10-16) and the spec's service entry has
    // no auth field, so they are not listed.
    services: [
      { name: 'agent-card', endpoint: `${agentUrl}/card` },
      { name: 'repid-proof-verify', endpoint: verifyUrl },
      { name: 'reputation-feedback', endpoint: `${agentUrl}/reputation/payload.json` },
    ],
    // No agent service here takes x402 payment; claiming it would be a new public claim.
    x402Support: false,
    active: ctx.active,
    registrations: [
      {
        agentId: Number.isSafeInteger(tokenNum) ? tokenNum : ctx.erc8004_token_id,
        agentRegistry: `eip155:${ctx.chain_id}:${ctx.identity_registry_address}`,
      },
    ],
    supportedTrust: ['reputation'],
    hyperdag: {
      current_repid: ctx.current_repid,
      tier: ctx.tier,
      verifier_package: '@hyperdag/proof-verifier@^0.1.0',
      verify_url: verifyUrl,
      proof_endpoint: `${BASE_ENGINE_URL}/api/v1/repid/proof/:job_id`,
      ...(ctx.slots ? { slots: ctx.slots } : {}),
    },
  };
}

export type RegistrationLookup =
  | { status: 'ok'; file: AgentRegistrationFile }
  | { status: 'not_found' }
  | { status: 'ambiguous' };

/**
 * Fetches an agent by UUID or by exact agent_name and renders its registration file.
 * A name is accepted so the minted token URIs that carry a name
 * (https://trustrepid.dev/agents/trinity-orch, tokens 6705-6712) can resolve here.
 * Only rows with a token id are considered, so `not_found` covers an unminted agent and two
 * unminted rows sharing a name are not told apart from a miss. Names are not unique, so more
 * than one MINTED match is `ambiguous` (use the id). DB errors throw; the route never echoes them.
 * Mounted at GET /api/v1/agents/:id/registration.json.
 */
export async function fetchAndGenerateRegistrationFile(
  supabase: SupabaseClient,
  ref: string
): Promise<RegistrationLookup> {
  const { data, error } = await supabase
    .from('repid_agents')
    .select('id, agent_name, description, current_repid, tier, lifecycle_status, erc8004_token_id, mint_chain_id')
    .eq(UUID_RE.test(ref) ? 'id' : 'agent_name', ref)
    .neq('erc8004_token_id', '') // PostgREST neq also drops NULL: minted rows only
    .limit(2);

  if (error) throw new Error(`agent lookup failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.length > 1) return { status: 'ambiguous' };
  const agent = rows[0];
  if (!agent || !agent.erc8004_token_id) return { status: 'not_found' };

  const chainId: number = agent.mint_chain_id ?? 84532;
  // The registry comes from config, never from repid_agents.erc8004_address: that column holds
  // placeholders, tx hashes and a one-character-off registry for some minted agents
  // (see src/identity/registry-address.ts), and the old shape check published one of them.
  const registry = canonicalIdentityRegistry(chainId);
  if (!registry) return { status: 'not_found' };

  return {
    status: 'ok',
    file: generateRegistrationFile({
      agent_id: agent.id,
      agent_name: agent.agent_name,
      description: agent.description || `HyperDAG-anchored AI agent ${agent.agent_name}`,
      current_repid: agent.current_repid || 0,
      tier: agent.tier || 'PROBATIONARY',
      active: agent.lifecycle_status === 'active',
      erc8004_token_id: String(agent.erc8004_token_id),
      chain_id: chainId,
      identity_registry_address: registry,
      // No slot store exists yet (no write path in this change), so ON serves an empty,
      // valid chain: max 3, no entries.
      slots: slotsEnabled() ? slotStateFromHistory([]) : undefined,
    }),
  };
}
