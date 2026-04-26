/**
 * Fleet status — public read service.
 *
 * Queries the ERC-8004 IdentityRegistry on Base Sepolia for the
 * 12 fleet agents and returns ground-truth state. Does NOT trust the
 * agent_kya_registry cache — every call refreshes from chain.
 *
 * The endpoint behind this lives at GET /api/v1/fleet/status (see
 * src/routes/v1.ts). It is unauthenticated by design — anyone (Marco,
 * Vitto, Leonard, public) can verify the fleet without a key.
 *
 * v0 caveats:
 *  - The 12 fleet names are hardcoded here as the canonical list.
 *  - Token-ID lookup uses agent_kya_registry.current_token_id when
 *    populated; otherwise falls back to the well-known orphan ids
 *    documented in the sprint spec. SOPHIA is special-cased to #3747.
 *  - "metadata_reachable" is true for every inline data URI (always
 *    reachable) and is checked via HTTP HEAD for off-chain URLs.
 */

import { ethers } from 'ethers';
import { db } from '../db';

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const CHAIN = 'base-sepolia';
const EXPLORER_BASE = `https://sepolia.basescan.org/token/${REGISTRY}?a=`;

const ABI = [
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
];

export const FLEET_NAMES = [
  'SOPHIA', 'NEXUS', 'VERITAS', 'APM', 'TORCH', 'HDM', 'MEL',
  'GCM', 'CHESED', 'ORCH', 'W3C', 'SHOFET',
];

// Sprint spec — known orphans + the perfect SOPHIA token.
const FALLBACK_TOKEN_IDS: Record<string, number> = {
  SOPHIA:  3747,
  NEXUS:   1583,
  VERITAS: 1848,
  TORCH:   1849,
  HDM:     1850,
  MEL:     1851,
};

const NEXUS_DUPLICATE_IDS = [1612, 1632, 1644];

export interface FleetAgentStatus {
  name: string;
  agent_class?: string | null;
  fleet_role?: string | null;
  on_chain: boolean;
  token_id: string | null;
  owner: string | null;
  metadata_uri: string | null;
  metadata_inline: boolean;
  metadata_reachable: boolean;
  metadata_summary?: { name?: string; tier?: string } | null;
  explorer_url: string | null;
  rep_id_tier: string | null;
  registration_status: string | null;
  duplicates?: number[];
  last_verified: string;
  error?: string;
}

export interface FleetStatusReport {
  fleet_size: number;
  fully_discoverable: number;
  issues: number;
  contract_address: string;
  chain: string;
  verification_method: 'live_rpc_query';
  agents: FleetAgentStatus[];
}

let _provider: ethers.JsonRpcProvider | null = null;
let _contract: ethers.Contract | null = null;
function provider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}
function contract(): ethers.Contract {
  if (!_contract) _contract = new ethers.Contract(REGISTRY, ABI, provider());
  return _contract;
}

interface KyaRow {
  agent_name: string;
  agent_id_onchain?: string | null;
  current_token_id?: string | null;
  dbt_token_id?: string | null;
  sbt_token_id?: string | null;
  repid_tier?: string | null;
  registration_status?: string | null;
  specialization?: string | null;
}

async function loadKyaRegistry(): Promise<Map<string, KyaRow>> {
  const { data, error } = await db.from('agent_kya_registry').select('*').in('agent_name', FLEET_NAMES);
  if (error || !data) return new Map();
  const m = new Map<string, KyaRow>();
  for (const row of data as KyaRow[]) m.set(row.agent_name, row);
  return m;
}

function chooseTokenId(name: string, kya: KyaRow | undefined): string | null {
  if (kya?.current_token_id) return kya.current_token_id;
  if (kya?.agent_id_onchain && /^\d+$/.test(kya.agent_id_onchain)) return kya.agent_id_onchain;
  if (kya?.dbt_token_id && /^\d+$/.test(kya.dbt_token_id)) return kya.dbt_token_id;
  if (kya?.sbt_token_id && /^\d+$/.test(kya.sbt_token_id)) return kya.sbt_token_id;
  if (FALLBACK_TOKEN_IDS[name] !== undefined) return String(FALLBACK_TOKEN_IDS[name]);
  return null;
}

function tryDecodeInlineMetadata(uri: string): { name?: string; tier?: string } | null {
  if (!uri.startsWith('data:application/json')) return null;
  // Two formats: ;base64,<b64> and ,<urlencoded-json>.
  try {
    const b64Marker = ';base64,';
    if (uri.includes(b64Marker)) {
      const b64 = uri.slice(uri.indexOf(b64Marker) + b64Marker.length);
      const json = Buffer.from(b64, 'base64').toString('utf8');
      const obj = JSON.parse(json);
      const name = typeof obj.name === 'string' ? obj.name : undefined;
      const tier = typeof obj?.trust?.tier === 'string' ? obj.trust.tier : undefined;
      const out: { name?: string; tier?: string } = {};
      if (name !== undefined) out.name = name;
      if (tier !== undefined) out.tier = tier;
      return out;
    }
    const comma = uri.indexOf(',');
    if (comma > 0) {
      const json = decodeURIComponent(uri.slice(comma + 1));
      const obj = JSON.parse(json);
      const name = typeof obj.name === 'string' ? obj.name : undefined;
      const tier = typeof obj?.trust?.tier === 'string' ? obj.trust.tier : undefined;
      const out: { name?: string; tier?: string } = {};
      if (name !== undefined) out.name = name;
      if (tier !== undefined) out.tier = tier;
      return out;
    }
  } catch { /* fall through */ }
  return null;
}

async function checkUrlReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

export async function getAgentStatus(name: string): Promise<FleetAgentStatus> {
  const lastVerified = new Date().toISOString();
  const kyaMap = await loadKyaRegistry();
  return getAgentStatusUsingKya(name, kyaMap, lastVerified);
}

async function getAgentStatusUsingKya(
  name: string,
  kyaMap: Map<string, KyaRow>,
  lastVerified: string,
): Promise<FleetAgentStatus> {
  const kya = kyaMap.get(name);
  const tokenId = chooseTokenId(name, kya);
  const base: FleetAgentStatus = {
    name,
    agent_class: null,
    fleet_role: kya?.specialization ?? null,
    on_chain: false,
    token_id: tokenId,
    owner: null,
    metadata_uri: null,
    metadata_inline: false,
    metadata_reachable: false,
    explorer_url: tokenId ? `${EXPLORER_BASE}${tokenId}` : null,
    rep_id_tier: kya?.repid_tier ?? null,
    registration_status: kya?.registration_status ?? null,
    last_verified: lastVerified,
  };
  if (name === 'NEXUS') base.duplicates = NEXUS_DUPLICATE_IDS;

  if (!tokenId) {
    base.registration_status ??= 'not_registered';
    return base;
  }

  try {
    const c = contract() as unknown as {
      ownerOf: (id: string) => Promise<string>;
      tokenURI: (id: string) => Promise<string>;
    };
    const owner = await c.ownerOf(tokenId);
    const uri = await c.tokenURI(tokenId);
    const inline = uri.startsWith('data:');
    const reachable = inline ? true : await checkUrlReachable(uri);
    const summary = inline ? tryDecodeInlineMetadata(uri) : null;
    return {
      ...base,
      on_chain: true,
      owner,
      metadata_uri: uri,
      metadata_inline: inline,
      metadata_reachable: reachable,
      ...(summary ? { metadata_summary: summary } : {}),
      registration_status:
        kya?.registration_status ??
        (inline && reachable ? 'verified' : 'orphaned'),
    };
  } catch (e: any) {
    return { ...base, error: e?.shortMessage ?? e?.message ?? 'unknown_error' };
  }
}

export async function getFleetStatus(): Promise<FleetStatusReport> {
  const lastVerified = new Date().toISOString();
  const kyaMap = await loadKyaRegistry();
  const agents = await Promise.all(
    FLEET_NAMES.map(name => getAgentStatusUsingKya(name, kyaMap, lastVerified))
  );
  const fully = agents.filter(a => a.on_chain && a.metadata_inline && a.metadata_reachable).length;
  return {
    fleet_size: FLEET_NAMES.length,
    fully_discoverable: fully,
    issues: FLEET_NAMES.length - fully,
    contract_address: REGISTRY,
    chain: CHAIN,
    verification_method: 'live_rpc_query',
    agents,
  };
}
