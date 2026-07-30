// Agent Trust Passport — the composite, honest, public answer to the one
// question agentic-commerce counterparties actually ask: "should I authorize
// this agent?" (merchant-side agent authorization became the gate after
// Amazon v. Perplexity, 2026-03 — user permission != merchant authorization).
//
// Composes ONLY already-real surfaces, DB-first (no per-request RPC calls, so
// no public-RPC latency dependency — see commit 5dccf7e for why that matters):
//   * repid_agents            — RepID score + DB-derived tier + ERC-8004 mint metadata
//   * x402_settlements        — real vs simulated settlement counts (per G1,
//                               reputation only accrues on non-simulated money)
//   * erc8004_reputation_writes — on-chain giveFeedback() write count
//   * repid_zkp_proofs        — latest proof row, labeled honestly
//
// HONESTY RULES (D-019 + RULE-4):
//   * No fabricated fields. Nothing here says "verified" unless a chain read
//     verified it — live verification is linked, not claimed.
//   * ZKP proofs are described as what they are today: range proofs over the
//     RepID score. They do NOT bind agent execution transcripts (roadmap).
//   * Sub-query failures throw (fail-loud) — a passport with silently-zeroed
//     counts would be a fabrication in the other direction.
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Canonical ERC-8004 registries on Base Sepolia (see src/config/network.ts).
const REPUTATION_REGISTRY_BASE_SEPOLIA =
  '0x8004B663056A597Dffe9eCcC1965A193B7388713';

export class PassportQueryError extends Error {
  constructor(public step: string, detail: string) {
    super(`passport query failed at ${step}: ${detail}`);
    this.name = 'PassportQueryError';
  }
}

function chainName(chainId: number | null): string | null {
  if (chainId === 84532) return 'base-sepolia';
  if (chainId === 8453) return 'base';
  return chainId === null ? null : `chain-${chainId}`;
}

function basescanTxUrl(chainId: number | null, txHash: string | null): string | null {
  if (!txHash) return null;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return `https://basescan.org/tx/${txHash}`;
}

export interface AgentPassport {
  passport_version: '1';
  as_of: string;
  agent: {
    agent_id: string;
    agent_name: string | null;
    display_name: string | null;
    created_at: string | null;
  };
  reputation: {
    repid_score: number;
    tier: string | null;
    activity_30d: number;
  };
  identity_erc8004: {
    registered_onchain: boolean;
    token_id: string | null;
    contract_address: string | null;
    chain_id: number | null;
    network: string | null;
    mint_tx_hash: string | null;
    mint_basescan_url: string | null;
    minted_at: string | null;
    conservator_address: string | null;
    // A LIVE ownerOf() cross-check exists; we link it instead of claiming it.
    live_verification_endpoint: string;
  };
  payments_x402: {
    real_settlements: number;
    simulated_settlements: number;
    last_real_settlement: {
      tx_hash: string;
      basescan_url: string | null;
      amount_base_units: number;
      asset: string | null;
      at: string | null;
    } | null;
    policy: string;
  };
  reputation_onchain: {
    registry_address: string;
    network: string;
    writes: number;
    last_write: { tx_hash: string | null; at: string | null; basescan_url: string | null } | null;
  };
  zkp: {
    latest_proof: {
      scheme: string | null;
      cryptographically_verifiable: boolean;
      eas_attestation_uid: string | null;
      created_at: string | null;
    } | null;
    disclosure: string;
    proof_endpoint: string;
    verify_endpoint: string;
  };
}

/**
 * Resolve a raw path param (UUID | ERC-8004 token id | agent name/slug) to the
 * repid_agents row, or null when no agent matches (caller 404s).
 */
async function fetchAgentRow(
  db: SupabaseClient,
  raw: string
): Promise<Record<string, any> | null> {
  const cols =
    'id, agent_name, display_name, current_repid, tier, activity_30d, created_at, ' +
    'erc8004_token_id, erc8004_address, mint_tx_hash, mint_chain_id, minted_at, conservator_address';

  const tryFetch = async (col: string, value: string) => {
    const { data, error } = await db
      .from('repid_agents')
      .select(cols)
      .eq(col, value)
      .maybeSingle();
    if (error) throw new PassportQueryError('agent_lookup', error.message);
    return data ?? null;
  };

  const id = String(raw ?? '').trim();
  if (!id) return null;
  if (UUID_RE.test(id)) return tryFetch('id', id);
  if (/^\d+$/.test(id)) return tryFetch('erc8004_token_id', id);

  // Name/slug: exact match first, then the legacy trinity- prefix convention
  // (parity with resolveAgentUuid in src/routes/repid.ts, minus its blind spot
  // for external agents whose names don't carry the prefix).
  const lcName = id.toLowerCase();
  const exact = await tryFetch('agent_name', lcName);
  if (exact) return exact;
  if (!lcName.startsWith('trinity-')) {
    return tryFetch('agent_name', `trinity-${lcName}`);
  }
  return null;
}

/**
 * Build the Agent Trust Passport. Returns null when the agent doesn't exist;
 * throws PassportQueryError when a sub-query fails (callers map to 500 —
 * fail-loud, never a silently-zeroed passport).
 */
export async function buildAgentPassport(
  db: SupabaseClient,
  rawAgentId: string
): Promise<AgentPassport | null> {
  const agent = await fetchAgentRow(db, rawAgentId);
  if (!agent) return null;

  const agentId = String(agent.id);
  const settlementParty = `provider_agent_id.eq.${agentId},requestor_agent_id.eq.${agentId}`;

  // -- x402: real vs simulated settled counts + last real tx ----------------
  const { count: realCount, error: realErr } = await db
    .from('x402_settlements')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'settled')
    .eq('is_simulated', false)
    .or(settlementParty);
  if (realErr) throw new PassportQueryError('x402_real_count', realErr.message);

  const { count: simCount, error: simErr } = await db
    .from('x402_settlements')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'settled')
    .eq('is_simulated', true)
    .or(settlementParty);
  if (simErr) throw new PassportQueryError('x402_sim_count', simErr.message);

  // Live-prod finding (2026-07-30, trinity-shofet): real_settlements=47 but
  // the newest real row can carry a null tx_hash / created_at, and Postgres
  // DESC sorts nulls first — which made last_real_settlement read null next
  // to a non-zero count. Skip hash-less rows and pin nulls last so the field
  // shows the latest INSPECTABLE settlement (the row count above still counts
  // every real row).
  const { data: lastReal, error: lastRealErr } = await db
    .from('x402_settlements')
    .select('tx_hash, created_at, amount, asset')
    .eq('status', 'settled')
    .eq('is_simulated', false)
    .or(settlementParty)
    .not('tx_hash', 'is', null)
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (lastRealErr) throw new PassportQueryError('x402_last_real', lastRealErr.message);

  // -- ERC-8004 reputation writes (same lifetime-count semantics as
  //    GET /observability/onchain-stats, scoped to this agent) --------------
  const { count: writesCount, error: writesErr } = await db
    .from('erc8004_reputation_writes')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);
  if (writesErr) throw new PassportQueryError('reputation_writes_count', writesErr.message);

  const { data: lastWrite, error: lastWriteErr } = await db
    .from('erc8004_reputation_writes')
    .select('tx_hash, created_at')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastWriteErr) throw new PassportQueryError('reputation_writes_last', lastWriteErr.message);

  // -- Latest ZKP proof row, labeled honestly -------------------------------
  const { data: latestProof, error: proofErr } = await db
    .from('repid_zkp_proofs')
    .select('scheme, proof_bytes, eas_attestation_uid, created_at')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (proofErr) throw new PassportQueryError('zkp_latest', proofErr.message);

  const minted = !!agent.mint_tx_hash;
  const mintChainId: number | null = agent.mint_chain_id ?? null;

  return {
    passport_version: '1',
    as_of: new Date().toISOString(),
    agent: {
      agent_id: agentId,
      agent_name: agent.agent_name ?? null,
      display_name: agent.display_name ?? agent.agent_name ?? null,
      created_at: agent.created_at ?? null,
    },
    reputation: {
      repid_score: agent.current_repid ?? 0,
      // tier is DB-derived by the trg_sync_tier trigger — it is the source of
      // truth and is NOT recomputed here.
      tier: agent.tier ?? null,
      activity_30d: agent.activity_30d ?? 0,
    },
    identity_erc8004: {
      registered_onchain: minted,
      token_id: agent.erc8004_token_id ?? null,
      contract_address: minted ? agent.erc8004_address ?? null : null,
      chain_id: mintChainId,
      network: chainName(mintChainId),
      mint_tx_hash: agent.mint_tx_hash ?? null,
      mint_basescan_url: basescanTxUrl(mintChainId, agent.mint_tx_hash ?? null),
      minted_at: agent.minted_at ?? null,
      conservator_address: agent.conservator_address ?? null,
      live_verification_endpoint: `/api/v1/agents/${agentId}/onchain`,
    },
    payments_x402: {
      real_settlements: realCount ?? 0,
      simulated_settlements: simCount ?? 0,
      last_real_settlement: lastReal?.tx_hash
        ? {
            tx_hash: lastReal.tx_hash,
            basescan_url: basescanTxUrl(84532, lastReal.tx_hash),
            amount_base_units: Number(lastReal.amount ?? 0),
            asset: lastReal.asset ?? null,
            at: lastReal.created_at ?? null,
          }
        : null,
      policy:
        'RepID deltas only accrue on non-simulated settlements; mock money earns zero reputation.',
    },
    reputation_onchain: {
      registry_address: REPUTATION_REGISTRY_BASE_SEPOLIA,
      network: 'base-sepolia',
      writes: writesCount ?? 0,
      last_write: lastWrite
        ? {
            tx_hash: lastWrite.tx_hash ?? null,
            at: lastWrite.created_at ?? null,
            basescan_url: basescanTxUrl(84532, lastWrite.tx_hash ?? null),
          }
        : null,
    },
    zkp: {
      latest_proof: latestProof
        ? {
            scheme: latestProof.scheme ?? null,
            cryptographically_verifiable:
              latestProof.scheme === 'plonky3_range_check' &&
              typeof latestProof.proof_bytes === 'string' &&
              latestProof.proof_bytes.length > 0,
            eas_attestation_uid: latestProof.eas_attestation_uid ?? null,
            created_at: latestProof.created_at ?? null,
          }
        : null,
      // D-019: never describe the proof as attesting agent behavior.
      disclosure:
        'Proofs are range proofs over the RepID score (score >= threshold without revealing the score). They do not yet bind agent execution transcripts — that binding is roadmap.',
      proof_endpoint: `/api/v1/repid/${agentId}/proof`,
      verify_endpoint: '/api/v1/repid/verify',
    },
  };
}
