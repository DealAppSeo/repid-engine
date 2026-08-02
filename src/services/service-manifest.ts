/**
 * service-manifest.ts — the canonical object a service IS.
 *
 * Spec: TRUSTMARKET_UX_MERGED_SPEC_v1 §1.2 (manifest-first, two renderers), §4
 * (machine surface), §10 (TrustBadge), §11 (component↔SDK parity).
 *
 * WHY THIS EXISTS. The spec's second load-bearing idea is that the human page and
 * the machine endpoint are two RENDERERS OF THE SAME OBJECT, so dual-audience
 * drift is impossible by construction rather than by discipline. That only holds
 * if the object actually exists in one place. This is that place. Every surface —
 * a service card, /.well-known/agent-services.json, an MCP tool result, a
 * TrustBadge — renders from here and nowhere else.
 *
 * WHAT IT REFUSES TO DO. §1.4 makes two honesty rules brand law, and both bite
 * here:
 *
 *   · STAKE-AT-RISK IS THE TOP TRUST PRIMITIVE (§11) — "they had $X to lose if
 *     they lied" beats any score. We currently have almost none: agent_stakes has
 *     4 rows and repid_agent_stakes has 0. So `stake_at_risk_usdc` is **null with
 *     a stated reason**, never 0 and never omitted. Rendering absent collateral
 *     as "$0.00 at risk" reads as a measured fact; rendering it as null with
 *     `stake_status: 'none_recorded'` says what is actually true.
 *
 *   · TRACK RECORD IS DENOMINATORED (§10) — "412 jobs · 99.2% verified · 3
 *     disputes" and never a bare percentage. A 100% success rate over 1 job is
 *     the most misleading number this system could publish, so the denominator
 *     travels with the rate, always, and `sample_size_warning` fires when the
 *     denominator is too small to mean anything.
 *
 * All values are read live. Nothing here is cached, seeded, or defaulted to a
 * flattering number.
 */

import { db } from '../db';

/** Below this many settled jobs, a success rate is noise and says so. */
export const MIN_MEANINGFUL_JOBS = 10;

export interface TrackRecord {
  settled_jobs: number;
  disputed_jobs: number;
  /** null when there is no denominator to divide by — never 0/0 rendered as 0%. */
  verified_rate: number | null;
  /** Human-legible and denominatored, per §10. */
  summary: string;
  /** True when settled_jobs is too small for the rate to carry meaning. */
  sample_size_warning: boolean;
}

export interface ServiceManifest {
  schema_version: '1.0';
  id: string;
  service_type: string;
  service_name: string | null;
  description: string | null;

  price: {
    amount_usdc_raw: number;
    amount_usdc: string;
    /** §8: multi-token for payments, stablecoin-only for staking. */
    accepted_tokens: string[];
    network: string;
    chain_id: number;
  };

  provider: {
    agent_id: string;
    agent_name: string | null;
    repid: number | null;
    tier: string | null;
    erc8004_token_id: string | null;
    /** §11 top trust primitive. null when none is recorded — see module header. */
    stake_at_risk_usdc: number | null;
    stake_status: 'recorded' | 'none_recorded';
    stake_note: string;
  };

  track_record: TrackRecord;

  requirements: {
    min_repid_to_purchase: number | null;
  };

  /** §9 — a real settled exchange for this provider, or null. Never fabricated. */
  sample_receipt: {
    contract_id: string;
    settled_at: string | null;
    url: string;
  } | null;

  /** The two renderers, named on the object itself so neither can drift silently. */
  renderers: {
    machine: string;
    human: string;
  };

  /** Anything a consumer should know before trusting a field above. */
  caveats: string[];
}

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;
const NETWORK = 'base-sepolia';

function publicBase(): string {
  return (
    process.env.PUBLIC_BASE_URL ||
    'https://repid-engine-production.up.railway.app'
  );
}

function rawToUsdc(raw: number): string {
  return (raw / 1e6).toFixed(6);
}

/**
 * Denominatored track record. The denominator is never dropped and a rate is
 * never invented from an empty sample.
 */
export function buildTrackRecord(settled: number, disputed: number): TrackRecord {
  const total = settled + disputed;
  const verified_rate = total > 0 ? Number(((settled / total) * 100).toFixed(1)) : null;
  const sample_size_warning = settled < MIN_MEANINGFUL_JOBS;

  let summary: string;
  if (total === 0) {
    summary = 'No completed jobs yet.';
  } else {
    const disputeText =
      disputed === 0 ? 'no disputes' : `${disputed} dispute${disputed === 1 ? '' : 's'}`;
    summary = `${settled} settled job${settled === 1 ? '' : 's'} · ${verified_rate}% verified · ${disputeText}`;
    if (sample_size_warning) {
      summary += ` · too few jobs for the rate to mean much`;
    }
  }

  return { settled_jobs: settled, disputed_jobs: disputed, verified_rate, summary, sample_size_warning };
}

/**
 * Build the manifest for one active service. Returns null when the service does
 * not exist or is inactive — an inactive service is not quietly rendered as live.
 */
export async function buildServiceManifest(serviceId: string): Promise<ServiceManifest | null> {
  const { data: svc } = await db
    .from('agent_services')
    .select(
      'id, provider_agent_id, service_type, service_name, description, base_price_usdc_raw, min_repid_to_purchase, active',
    )
    .eq('id', serviceId)
    .maybeSingle();
  if (!svc || (svc as any).active !== true) return null;

  return assembleManifest(svc as any);
}

/** The whole active catalog, one manifest each. */
export async function buildServiceCatalog(limit = 200): Promise<ServiceManifest[]> {
  const { data: rows } = await db
    .from('agent_services')
    .select(
      'id, provider_agent_id, service_type, service_name, description, base_price_usdc_raw, min_repid_to_purchase, active',
    )
    .eq('active', true)
    .limit(limit);
  if (!rows || rows.length === 0) return [];

  const out: ServiceManifest[] = [];
  for (const r of rows as any[]) {
    out.push(await assembleManifest(r));
  }
  return out;
}

/**
 * Everything trustworthy we can say about one provider, computed once.
 *
 * Extracted so the manifest and the TrustBadge (§10) cannot disagree about the
 * same agent. A badge that says "99% verified" beside a manifest that says
 * "too few jobs to tell" would be worse than having no badge — the badge is the
 * artifact that travels off-site, so it is the one that must not drift.
 */
export interface ProviderTrust {
  agent_id: string;
  agent_name: string | null;
  repid: number | null;
  tier: string | null;
  erc8004_token_id: string | null;
  stake_at_risk_usdc: number | null;
  stake_status: 'recorded' | 'none_recorded';
  stake_note: string;
  track_record: TrackRecord;
  sample_receipt: { contract_id: string; settled_at: string | null; url: string } | null;
  caveats: string[];
}

export async function buildProviderTrust(agentId: string): Promise<ProviderTrust | null> {
  const caveats: string[] = [];

  const { data: agent } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, tier, erc8004_token_id')
    .eq('id', agentId)
    .maybeSingle();
  if (!agent) return null;

  // Track record: settled vs disputed, for THIS provider.
  const { count: settledCount } = await db
    .from('service_contracts')
    .select('*', { count: 'exact', head: true })
    .eq('provider_agent_id', agentId)
    .eq('status', 'settled');
  const { count: disputedCount } = await db
    .from('service_contracts')
    .select('*', { count: 'exact', head: true })
    .eq('provider_agent_id', agentId)
    .not('disputed_at', 'is', null);

  const track_record = buildTrackRecord(settledCount ?? 0, disputedCount ?? 0);
  if (track_record.sample_size_warning && track_record.settled_jobs > 0) {
    caveats.push(
      `This provider has ${track_record.settled_jobs} settled job(s). A success rate over so few ` +
        `jobs is not yet evidence of reliability.`,
    );
  }
  if (track_record.settled_jobs === 0) {
    caveats.push('This provider has never completed a job through the protocol.');
  }

  // Stake at risk — the top trust primitive, and mostly absent. Say so.
  const { data: stakeRows } = await db
    .from('agent_stakes')
    .select('stake_amount, status')
    .eq('staker_agent', agentId)
    .eq('status', 'active');
  const staked = (stakeRows ?? []).reduce(
    (sum: number, r: any) => sum + Number(r.stake_amount ?? 0),
    0,
  );
  const hasStake = (stakeRows ?? []).length > 0 && staked > 0;
  if (!hasStake) {
    caveats.push(
      'No stake is recorded against this provider, so nothing of theirs is financially at risk ' +
        'if they underdeliver. Judge the track record accordingly.',
    );
  }

  // A real settled exchange, or nothing.
  const { data: sample } = await db
    .from('service_contracts')
    .select('id, settled_at')
    .eq('provider_agent_id', agentId)
    .eq('status', 'settled')
    .order('settled_at', { ascending: false })
    .limit(1);
  const sampleRow = (sample ?? [])[0] as any;
  const base = publicBase();

  return {
    agent_id: String(agentId),
    agent_name: (agent as any)?.agent_name ?? null,
    repid: (agent as any)?.current_repid ?? null,
    tier: (agent as any)?.tier ?? null,
    erc8004_token_id: (agent as any)?.erc8004_token_id ?? null,
    stake_at_risk_usdc: hasStake ? Number((staked / 1e6).toFixed(6)) : null,
    stake_status: hasStake ? 'recorded' : 'none_recorded',
    stake_note: hasStake
      ? 'Stake recorded against this provider and slashable on proven underdelivery.'
      : "No stake recorded. Nothing of the provider's is financially at risk on this service.",
    track_record,
    sample_receipt: sampleRow
      ? {
          contract_id: String(sampleRow.id),
          settled_at: sampleRow.settled_at ?? null,
          url: `${base}/api/v1/receipt/${sampleRow.id}.json`,
        }
      : null,
    caveats,
  };
}

async function assembleManifest(svc: {
  id: string;
  provider_agent_id: string;
  service_type: string;
  service_name: string | null;
  description: string | null;
  base_price_usdc_raw: number | null;
  min_repid_to_purchase: number | null;
}): Promise<ServiceManifest> {
  const trust = await buildProviderTrust(svc.provider_agent_id);
  const caveats = [...(trust?.caveats ?? [])];
  const track_record = trust?.track_record ?? buildTrackRecord(0, 0);
  const sampleRow = trust?.sample_receipt ?? null;
  const base = publicBase();
  const priceRaw = Number(svc.base_price_usdc_raw ?? 0);

  return {
    schema_version: '1.0',
    id: String(svc.id),
    service_type: svc.service_type,
    service_name: svc.service_name ?? null,
    description: svc.description ?? null,

    price: {
      amount_usdc_raw: priceRaw,
      amount_usdc: rawToUsdc(priceRaw),
      accepted_tokens: [USDC_BASE_SEPOLIA],
      network: NETWORK,
      chain_id: CHAIN_ID,
    },

    provider: {
      agent_id: String(svc.provider_agent_id),
      agent_name: trust?.agent_name ?? null,
      repid: trust?.repid ?? null,
      tier: trust?.tier ?? null,
      erc8004_token_id: trust?.erc8004_token_id ?? null,
      stake_at_risk_usdc: trust?.stake_at_risk_usdc ?? null,
      stake_status: trust?.stake_status ?? 'none_recorded',
      stake_note:
        trust?.stake_note ??
        "No stake recorded. Nothing of the provider's is financially at risk on this service.",
    },

    track_record,

    requirements: {
      min_repid_to_purchase: svc.min_repid_to_purchase ?? null,
    },

    sample_receipt: sampleRow,

    renderers: {
      machine: `${base}/api/v1/services/${svc.id}/manifest.json`,
      human: `https://trustmarket.dev/service/${svc.id}`,
    },

    caveats,
  };
}
