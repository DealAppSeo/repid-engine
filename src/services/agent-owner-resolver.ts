/**
 * agent-owner-resolver.ts — ONE answer to "who owns this agent, and how sure are we?"
 *
 * WHY THIS EXISTS. Five different mechanisms in this system claim to say who is
 * behind an agent, and none of them is authoritative. They disagree about the
 * key, about what counts as evidence, and about whether an answer exists at all.
 * Every caller that wanted an owner therefore picked one and inherited its
 * weaknesses silently. This module picks ONE order, states why, and — crucially —
 * refuses to guess when the sources cannot answer.
 *
 * THE PRECEDENCE, AND THE REASON FOR IT. Ranked by how hard the claim is to
 * forge, never by how many rows the source has (LESSONS 4: evidence outranks the
 * label; population is not evidence). The most populated source is ranked LAST on
 * purpose.
 *
 *   1 proven_human        a signature over a message naming THIS agent, from a
 *                         wallet that additionally passed proof-of-human.
 *                         Someone proved key control AND distinct personhood.
 *   2 proven_wallet       the same signature without the personhood proof. Sybil-
 *                         able, so strictly weaker — and strictly stronger than
 *                         anything unsigned.
 *   3 attested_unverified a row that CARRIES a signature which this resolver does
 *                         not re-verify, and which is keyed by a NON-UNIQUE text
 *                         name rather than by the agent's uuid
 *                         (`agent_delegations`, `agent_custodianship_links`). An
 *                         unverified signature is a claim, not a proof — hence
 *                         below 1-2 — but there is an artifact to check later,
 *                         hence above anything with none.
 *   4 declared            an operator set a custodian tier / spending authority.
 *                         No signature and no counterparty, but somebody
 *                         deliberately wrote a number about custody.
 *   5 administrative      a foreign key set as a side effect of agent creation.
 *                         `routes/v1/byok.ts` already states this is "an
 *                         administrative association nobody signed … NOT evidence
 *                         of ownership". Ranking it last is what keeps that true.
 *
 * DELIBERATELY NOT A SOURCE: `repid_agents.conservator_address`. It reads like a
 * custodian and is not one — it is this engine's own minting signer
 * (`services/erc8004-minter.ts`). MEASURED 2026-08-17: ONE distinct value across
 * every agent that has one, matching zero rows in `builders`. A platform key is
 * not a user, and treating it as one would hand every such agent the same owner.
 *
 * UNKNOWN IS NOT "NO OWNER". This is the house rule from
 * `migrations/2026_08_11_v_fleet_truth_no_dead_from_silence.sql`: TRUE only on
 * positive evidence, NULL when there is no signal — never FALSE from silence.
 * Here that means three statuses, never two:
 *   resolved  a source produced an owner.
 *   none      every applicable source was consulted and had nothing.
 *   unknown   a source could not be consulted — read failed, or the key is
 *             ambiguous. NOT the same as "this agent has no owner", and a caller
 *             that collapses the two is reintroducing the bug that view fixed.
 *
 * THE CANONICAL KEY IS `repid_agents.id` (uuid), AND THAT IS A FINDING, NOT A
 * PREFERENCE. MEASURED 2026-08-17: `repid_agents.agent_name` is NOT unique — 8
 * names cover 39 rows, one name covering 8 rows. Every text-keyed source
 * (`agent_delegations.agent_id`, `agent_kya_registry.agent_name`) therefore names
 * a SET of agents, not an agent. A signed spending grant that names a colliding
 * string authorises all of them. So:
 *   - the resolver canonicalises to the uuid before consulting anything;
 *   - a name that resolves to more than one row returns `unknown`, never a pick;
 *   - text-keyed sources are consulted only when the key is unambiguous.
 * Normalising the name (case-fold, strip a `trinity-` prefix) is what makes the
 * KYA source join at all — an exact-name join matches ZERO agents — but it MERGES
 * two otherwise-distinct names, so it widens ambiguity rather than fixing it.
 * That is why normalisation is used only to look up, and never to disambiguate.
 *
 * This module DECIDES NOTHING. It has no gate, no flag, and it never writes.
 * Its first caller is the shadow comparison in `services/owner-ceiling-shadow.ts`.
 */
import { db } from '../db';

/** How strongly the claim is established. Ordered by RANK below, never by population. */
export type OwnerAssurance =
  | 'proven_human'
  | 'proven_wallet'
  | 'attested_unverified'
  | 'declared'
  | 'administrative';

/** Higher wins. Exported so a caller can compare two resolutions without re-deriving the order. */
export const ASSURANCE_RANK: Record<OwnerAssurance, number> = {
  proven_human: 5,
  proven_wallet: 4,
  attested_unverified: 3,
  declared: 2,
  administrative: 1,
};

/** Which table the claim came from. Named so a disagreement can be traced to its row. */
export type OwnerSource =
  | 'human_agent_bindings'
  | 'agent_delegations'
  | 'agent_custodianship_links'
  | 'agent_kya_registry'
  | 'repid_agents.builder_id';

export type OwnerKeyKind = 'builder_id' | 'human_sbt_token' | 'wallet' | 'opaque';

export interface OwnerClaim {
  source: OwnerSource;
  assurance: OwnerAssurance;
  /** Identifier of the owner in whatever namespace `ownerKeyKind` names. */
  ownerKey: string | null;
  ownerKeyKind: OwnerKeyKind;
  /**
   * Owner-imposed per-transaction ceiling in USDC, if this source carries one.
   * null means "this source says nothing about limits" — NOT "no limit".
   */
  capUsdcPerTx: number | null;
  /**
   * Cumulative-over-life ceiling in USDC, if carried. NOT a daily limit and must
   * never be used as one — see owner-ceiling-shadow.ts.
   */
  capUsdcTotal: number | null;
}

/**
 * What one source had to say. `empty` and `not_applicable` are both "no owner
 * from here"; `indeterminate` is "we could not look", and it is the only one that
 * can turn the whole resolution into `unknown`.
 */
export type SourceProbe =
  | { source: OwnerSource; status: 'claim'; claim: OwnerClaim }
  | { source: OwnerSource; status: 'empty' }
  | { source: OwnerSource; status: 'not_applicable'; reason: string }
  | { source: OwnerSource; status: 'indeterminate'; reason: string };

export type OwnerStatus = 'resolved' | 'none' | 'unknown';

export interface OwnerResolution {
  status: OwnerStatus;
  /** Canonical agent key (repid_agents.id) when it could be established. */
  agentId: string | null;
  /** The winning claim. Null unless status === 'resolved'. */
  owner: OwnerClaim | null;
  /**
   * EVERY claim, highest assurance first — not just the winner.
   *
   * Identity and limits come from different sources here: the strongest identity
   * evidence (a signed binding) deliberately carries NO spending authority, while
   * the sources that do carry caps are weaker identity evidence. Keeping only the
   * winner would silently discard every ceiling in the system, so attenuation
   * reads this list rather than `owner`.
   */
  claims: OwnerClaim[];
  /**
   * Claims from LOWER-ranked sources that name a different owner. Reported, never
   * used: a signed statement is not overturned by an unsigned row that disagrees
   * with it. A non-empty list means somebody should look.
   */
  conflicts: OwnerClaim[];
  /** Machine-readable reason, always set for `unknown`. */
  reason: string | null;
  /** Every source and what it said — so "we did not look" is legible afterwards. */
  probes: SourceProbe[];
}

// --- Pure reconciliation ---------------------------------------------------

/**
 * Fold the probes into one answer. Pure — all state injected.
 *
 * Rules, in order:
 *   1. If any source produced a claim, the highest-ranked claim wins. Lower-ranked
 *      claims naming a different owner are recorded as conflicts, never merged.
 *      A higher-ranked claim is NOT downgraded by a lower-ranked disagreement:
 *      that is the whole point of ranking by evidence.
 *   2. Otherwise, if any source was indeterminate, the answer is `unknown`. An
 *      unread source cannot support "no owner".
 *   3. Otherwise `none` — every applicable source was consulted and empty.
 *   4. With no probes at all the answer is `unknown`, not `none`. Consulting
 *      nothing is not evidence of absence.
 */
export function reconcileOwner(probes: SourceProbe[], agentId: string | null = null): OwnerResolution {
  const claims: OwnerClaim[] = [];
  for (const p of probes) if (p.status === 'claim') claims.push(p.claim);

  if (claims.length > 0) {
    const ordered = [...claims].sort((a, b) => ASSURANCE_RANK[b.assurance] - ASSURANCE_RANK[a.assurance]);
    const winner = ordered[0] as OwnerClaim;
    const conflicts = ordered.slice(1).filter((c) => !sameOwner(c, winner));
    return { status: 'resolved', agentId, owner: winner, claims: ordered, conflicts, reason: null, probes };
  }

  const indeterminate = probes.find((p) => p.status === 'indeterminate');
  if (indeterminate && indeterminate.status === 'indeterminate') {
    return { status: 'unknown', agentId, owner: null, claims: [], conflicts: [], reason: indeterminate.reason, probes };
  }

  if (probes.length === 0) {
    return { status: 'unknown', agentId, owner: null, claims: [], conflicts: [], reason: 'no_sources_consulted', probes };
  }

  return { status: 'none', agentId, owner: null, claims: [], conflicts: [], reason: null, probes };
}

/**
 * Two claims name the same owner only when the namespace AND the key match. A
 * builder uuid and an SBT token id that happen to be equal strings are not the
 * same principal, and comparing across namespaces would silently hide a conflict.
 */
export function sameOwner(a: OwnerClaim, b: OwnerClaim): boolean {
  if (a.ownerKey === null || b.ownerKey === null) return false;
  return a.ownerKeyKind === b.ownerKeyKind && a.ownerKey.toLowerCase() === b.ownerKey.toLowerCase();
}

/**
 * The owner's per-transaction ceiling: the TIGHTEST cap stated by any live claim,
 * not the cap of the winning identity claim.
 *
 * Taking the minimum is safe under the one invariant that governs this whole
 * module — a delegation may only ever NARROW authority
 * (`trinity-ecosystem/lib/trustshell/identity/capability.ts`). Two owners' limits
 * can only intersect to something no wider than either. Taking the winner's cap
 * instead would let a stronger identity claim that states no limit ERASE a
 * tighter limit somebody actually signed, which is the widening direction.
 *
 * Returns null when no claim states a limit. A caller must read that as "no
 * attenuation available", never as zero.
 */
export function ownerPerTxCap(resolution: OwnerResolution): number | null {
  const caps = resolution.claims
    .map((c) => c.capUsdcPerTx)
    .filter((c): c is number => c !== null && c !== undefined && Number.isFinite(c));
  if (caps.length === 0) return null;
  return Math.min(...caps);
}

// --- Key canonicalisation --------------------------------------------------

/**
 * Normalised lookup key for the text-keyed sources: case-folded, `trinity-`
 * prefix stripped. Exported because the ambiguity it creates has to be testable.
 */
export function normalizeAgentKey(name: string): string {
  return name.replace(/^trinity-/i, '').toUpperCase();
}

/**
 * PostgREST `or=` filters are comma/parenthesis-delimited, so a name containing
 * those characters would be parsed as filter syntax rather than matched as a
 * value. Rather than guess an escaping scheme, names outside this set are
 * declared unsafe and the text-keyed sources return `indeterminate` — a loud
 * "not checked" instead of a filter that quietly matches the wrong rows
 * (LESSONS 5: match the real names, not the tidy ones you imagine).
 */
export function isKeySafeForFilter(name: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(name);
}

export interface AgentRef {
  /** repid_agents.id — the canonical key. Supply this when you have it. */
  id?: string;
  /** repid_agents.agent_name — NOT unique. Resolved to a uuid, or `unknown`. */
  agentName?: string;
}

interface AgentRow {
  id: string;
  agent_name: string;
  builder_id: string | null;
  erc8004_token_id: string | null;
}

// --- Live resolution -------------------------------------------------------

/**
 * Resolve the owner of an agent. Reads only; writes nothing; throws nothing —
 * every failure becomes a probe with status `indeterminate`, which surfaces as
 * `unknown` rather than as a false `none`.
 */
export async function resolveOwner(ref: AgentRef): Promise<OwnerResolution> {
  let agent: AgentRow | null;
  try {
    agent = await loadAgent(ref);
  } catch (err) {
    return unknownResolution(null, `agent_lookup_failed:${msg(err)}`);
  }
  if (agent === null) {
    // Either no such agent, or a name naming several. loadAgent distinguishes by
    // throwing for the ambiguous case, so reaching here means "not found".
    return unknownResolution(null, 'agent_not_found');
  }

  const probes: SourceProbe[] = [];
  probes.push(await probeBinding(agent));
  probes.push(await probeDelegation(agent));
  probes.push(await probeCustodianshipLink(agent));
  probes.push(await probeKyaCustodian(agent));
  probes.push(probeBuilderId(agent));

  return reconcileOwner(probes, agent.id);
}

function unknownResolution(agentId: string | null, reason: string): OwnerResolution {
  return { status: 'unknown', agentId, owner: null, claims: [], conflicts: [], reason, probes: [] };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ambiguity is an error, not a silent pick. */
class AmbiguousAgentKey extends Error {}

async function loadAgent(ref: AgentRef): Promise<AgentRow | null> {
  const cols = 'id, agent_name, builder_id, erc8004_token_id';
  if (ref.id) {
    const { data, error } = await db.from('repid_agents').select(cols).eq('id', ref.id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as AgentRow | null) ?? null;
  }
  if (!ref.agentName) throw new Error('no_agent_ref');

  const { data, error } = await db.from('repid_agents').select(cols).eq('agent_name', ref.agentName);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as AgentRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // MEASURED: this is reachable — 8 names cover 39 rows in production. Picking
    // the first would attach an owner (and a spending ceiling) to the wrong agent.
    throw new AmbiguousAgentKey(`ambiguous_agent_name:${rows.length}_rows`);
  }
  return rows[0] as AgentRow;
}

/** 1-2: the signed binding. Keyed on the canonical uuid, so never ambiguous. */
async function probeBinding(agent: AgentRow): Promise<SourceProbe> {
  const source: OwnerSource = 'human_agent_bindings';
  try {
    const { data, error } = await db
      .from('human_agent_bindings')
      .select('owner_kind, human_token_id, builder_id, human_wallet, bound_at')
      .eq('agent_id', agent.id)
      .eq('scope', 'ownership')
      .is('revoked_at', null)
      .order('bound_at', { ascending: false });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<{
      owner_kind: string | null;
      human_token_id: string | null;
      builder_id: string | null;
      human_wallet: string | null;
    }>;
    const row = rows[0];
    if (!row) return { source, status: 'empty' };

    const isSbt = row.owner_kind === 'human_sbt';
    return {
      source,
      status: 'claim',
      claim: {
        source,
        assurance: isSbt ? 'proven_human' : 'proven_wallet',
        ownerKey: (isSbt ? row.human_token_id : row.builder_id) ?? row.human_wallet,
        ownerKeyKind: isSbt ? 'human_sbt_token' : 'builder_id',
        // A binding is a statement of ownership. It grants no spending authority
        // and carries no limits — see the message text in human-agent-binding.ts.
        capUsdcPerTx: null,
        capUsdcTotal: null,
      },
    };
  } catch (err) {
    return { source, status: 'indeterminate', reason: `binding_read_failed:${msg(err)}` };
  }
}

/**
 * 3: the EIP-712 signed delegation — the only source that carries a spending
 * ceiling somebody actually signed.
 *
 * `services/agent-delegation.ts#recordDelegation` verifies the signature and the
 * delegator's ownership at WRITE time. This resolver does not re-verify at READ
 * time, so the claim is `attested_unverified` rather than proven: a row is
 * evidence that a check ran once, not a check running now.
 *
 * `agent_delegations.agent_id` is TEXT holding an agent NAME, and names are not
 * unique (8 names cover 39 agent rows, MEASURED 2026-08-17). A grant naming a
 * colliding string authorises every agent that shares it — so this probe refuses
 * to attribute one when the name is ambiguous, and reports `indeterminate`
 * instead. `migrations/2026_08_17_agent_delegations_agent_uuid.sql` (UNAPPLIED)
 * is the schema fix that removes the ambiguity at the source.
 */
async function probeDelegation(agent: AgentRow): Promise<SourceProbe> {
  const source: OwnerSource = 'agent_delegations';
  if (!isKeySafeForFilter(agent.agent_name)) {
    return { source, status: 'indeterminate', reason: 'agent_name_unsafe_for_key_match' };
  }
  try {
    const siblings = await countAgentsNamed(agent.agent_name);
    if (siblings > 1) {
      return { source, status: 'indeterminate', reason: 'ambiguous_agent_name_for_delegation' };
    }

    const { data, error } = await db
      .from('agent_delegations')
      .select('delegator_builder_id, delegator_address, scope_json, expires_at, revoked_at')
      .eq('agent_id', agent.agent_name)
      .is('revoked_at', null);
    if (error) throw new Error(error.message);

    const now = Date.now();
    const live = ((data ?? []) as Array<{
      delegator_builder_id: string | null;
      delegator_address: string | null;
      scope_json: { max_usdc_per_tx?: number; max_usdc_total?: number } | null;
      expires_at: string;
    }>).filter((d) => new Date(d.expires_at).getTime() > now);
    if (live.length === 0) return { source, status: 'empty' };

    // Several live grants: the owner's effective ceiling is the widest single
    // grant they signed, because `decideCoverage` already allows a transaction
    // that ANY one grant covers. Attenuating to the tightest here would state a
    // ceiling stricter than the enforcement path would apply, making the shadow
    // over-report the cost of switching on.
    const perTx = live
      .map((d) => Number(d.scope_json?.max_usdc_per_tx ?? Number.NaN))
      .filter((n) => Number.isFinite(n));
    const total = live
      .map((d) => Number(d.scope_json?.max_usdc_total ?? Number.NaN))
      .filter((n) => Number.isFinite(n));
    const first = live[0] as { delegator_builder_id: string | null; delegator_address: string | null };

    return {
      source,
      status: 'claim',
      claim: {
        source,
        assurance: 'attested_unverified',
        ownerKey: first.delegator_builder_id ?? first.delegator_address,
        ownerKeyKind: first.delegator_builder_id ? 'builder_id' : 'wallet',
        capUsdcPerTx: perTx.length > 0 ? Math.max(...perTx) : null,
        capUsdcTotal: total.length > 0 ? Math.max(...total) : null,
      },
    };
  } catch (err) {
    return { source, status: 'indeterminate', reason: `delegation_read_failed:${msg(err)}` };
  }
}

/** How many agent rows carry this exact name. >1 is the ambiguity that blocks text-keyed sources. */
async function countAgentsNamed(name: string): Promise<number> {
  const { data, error } = await db.from('repid_agents').select('id').eq('agent_name', name);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown[]).length;
}

/**
 * 3 (also): the signature-bearing custodianship row.
 *
 * Keyed on `agent_dbt_id`, an integer token id. The only column on an agent that
 * could carry it is `erc8004_token_id`, so that is the join attempted here.
 *
 * MEASURED 2026-08-17: the single live row in this table joins to NOTHING — not
 * by that token id, and its `human_address` matches no builder and no registered
 * human. So this probe returns `not_applicable` or `empty` for every agent today.
 * That is a real result about the data, not a stub: the join is attempted, and it
 * will start producing claims the moment the ids line up.
 */
async function probeCustodianshipLink(agent: AgentRow): Promise<SourceProbe> {
  const source: OwnerSource = 'agent_custodianship_links';
  if (!agent.erc8004_token_id) {
    return { source, status: 'not_applicable', reason: 'agent_has_no_onchain_token_id' };
  }
  try {
    const { data, error } = await db
      .from('agent_custodianship_links')
      .select('human_address, capabilities, expires_at, status')
      .eq('agent_dbt_id', agent.erc8004_token_id)
      .eq('status', 'active');
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<{ human_address: string | null; expires_at: number | string | null }>;
    const row = rows[0];
    if (!row) return { source, status: 'empty' };

    // expires_at is a bigint unix seconds column here, unlike the timestamptz of
    // the same name on agent_delegations. Expired rows are not owners.
    const expiry = Number(row.expires_at ?? 0);
    if (Number.isFinite(expiry) && expiry > 0 && expiry * 1000 <= Date.now()) {
      return { source, status: 'empty' };
    }
    return {
      source,
      status: 'claim',
      claim: {
        source,
        // The row carries a signature this module does NOT verify: the signed
        // payload format is not recorded anywhere readable from here. Saying
        // "proven" on the strength of an unchecked signature is exactly the
        // fake-pass this repo keeps finding.
        assurance: 'attested_unverified',
        ownerKey: row.human_address,
        ownerKeyKind: 'wallet',
        capUsdcPerTx: null,
        capUsdcTotal: null,
      },
    };
  } catch (err) {
    return { source, status: 'indeterminate', reason: `custodianship_read_failed:${msg(err)}` };
  }
}

/**
 * 4: the declared custodian on the KYA registry — the columns built for exactly
 * this question that no code in this repo has ever read.
 *
 * Keyed on `agent_name`, which is neither unique nor written in the same form as
 * `repid_agents.agent_name`: MEASURED 2026-08-17, an exact join matches ZERO
 * agents and a normalised join matches 12. So the normalised key is the only one
 * that works — and it merges two distinct names, so it is used ONLY after
 * confirming that exactly one agent row carries it.
 */
async function probeKyaCustodian(agent: AgentRow): Promise<SourceProbe> {
  const source: OwnerSource = 'agent_kya_registry';
  const base = normalizeAgentKey(agent.agent_name);
  if (!isKeySafeForFilter(base)) {
    return { source, status: 'indeterminate', reason: 'agent_name_unsafe_for_key_match' };
  }
  try {
    // Is the normalised key unique across agents? If not, a row keyed by name
    // cannot be attributed to THIS agent, and guessing is the failure mode.
    const { data: sibs, error: sibErr } = await db
      .from('repid_agents')
      .select('id')
      .or(`agent_name.ilike.${base},agent_name.ilike.trinity-${base}`);
    if (sibErr) throw new Error(sibErr.message);
    if (((sibs ?? []) as unknown[]).length !== 1) {
      // Not exactly one agent behind this normalised key: either it collides, or
      // the agent does not match the key derived from its own name. Either way
      // a name-keyed row cannot be attributed to THIS agent.
      return { source, status: 'indeterminate', reason: 'normalized_agent_name_not_unique' };
    }

    const { data, error } = await db
      .from('agent_kya_registry')
      .select('agent_name, custodian_tier, custodian_spending_authority, custodian_link_active, custodian_revoked_at')
      .or(`agent_name.ilike.${base},agent_name.ilike.trinity-${base}`);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<{
      custodian_tier: string | null;
      custodian_spending_authority: number | string | null;
      custodian_link_active: boolean | null;
      custodian_revoked_at: string | null;
    }>;
    const row = rows.find((r) => r.custodian_link_active === true && r.custodian_revoked_at === null);
    if (!row) return { source, status: 'empty' };

    const cap = row.custodian_spending_authority;
    return {
      source,
      status: 'claim',
      claim: {
        source,
        assurance: 'declared',
        // The registry records a custodian TIER, not a custodian identity — there
        // is no owner id to return. `null` here says "somebody is declared, we
        // cannot name them", which is why ownerKey is nullable at all.
        ownerKey: row.custodian_tier,
        ownerKeyKind: 'opaque',
        capUsdcPerTx: cap === null || cap === undefined ? null : Number(cap),
        capUsdcTotal: null,
      },
    };
  } catch (err) {
    return { source, status: 'indeterminate', reason: `kya_read_failed:${msg(err)}` };
  }
}

/** 5: the administrative FK. Already loaded with the agent — no second read, and it cannot fail. */
function probeBuilderId(agent: AgentRow): SourceProbe {
  const source: OwnerSource = 'repid_agents.builder_id';
  if (!agent.builder_id) return { source, status: 'empty' };
  return {
    source,
    status: 'claim',
    claim: {
      source,
      assurance: 'administrative',
      ownerKey: agent.builder_id,
      ownerKeyKind: 'builder_id',
      capUsdcPerTx: null,
      capUsdcTotal: null,
    },
  };
}

export { AmbiguousAgentKey };

/**
 * The coverage measurement, versioned next to the precedence it mirrors.
 *
 * Exported as a string for the same reason CustodyShadow does it: an analysis
 * that lives in someone's shell history cannot be re-run against a later
 * database and compared. Read `unknown` FIRST — it is the count of agents whose
 * ownership could not be determined, and reading it as "no owner" is the exact
 * mistake `v_fleet_truth` was fixed to stop.
 *
 * This SQL and `reconcileOwner` are two implementations of one order and CAN
 * drift. The TypeScript is authoritative; this is the instrument.
 */
export const OWNER_COVERAGE_SQL = `
with norm as (
  select a.id, a.agent_name, a.tier, a.builder_id, a.erc8004_token_id,
         upper(regexp_replace(a.agent_name, '^trinity-', '', 'i')) as nkey
  from repid_agents a
), card as (
  select nkey, count(*) as n from norm group by 1
), kya as (
  select upper(regexp_replace(k.agent_name, '^trinity-', '', 'i')) as nkey,
         bool_or(k.custodian_link_active) as active,
         max(k.custodian_spending_authority) as cap
  from agent_kya_registry k
  where k.custodian_revoked_at is null
  group by 1
)
select
  case
    when exists (select 1 from human_agent_bindings b
                  where b.agent_id = n.id and b.revoked_at is null and b.owner_kind = 'human_sbt')
      then 'proven_human'
    when exists (select 1 from human_agent_bindings b
                  where b.agent_id = n.id and b.revoked_at is null)
      then 'proven_wallet'
    when n.erc8004_token_id is not null
     and exists (select 1 from agent_custodianship_links l
                  where l.agent_dbt_id::text = n.erc8004_token_id and l.status = 'active')
      then 'attested_unverified'
    when c.n = 1 and kya.active is true then 'declared'
    when n.builder_id is not null then 'administrative'
    when c.n > 1 then 'unknown (ambiguous key — NOT no-owner)'
    else 'none'
  end as assurance,
  count(*) as agents,
  count(case when c.n = 1 then kya.cap end) as with_owner_cap
from norm n
join card c on c.nkey = n.nkey
left join kya on kya.nkey = n.nkey
group by 1
order by agents desc;
`.trim();
