/**
 * F1 — ONE ACCOUNTABLE ROOT, checked on every action that commits money or hands on power.
 *
 * The rule (Grok's guidance, Sean's GO 2026-10-07): an agent buys, sells or widens what another
 * agent may do only while the chain above it ends at someone who can be asked to answer. Before
 * this, each route asked its own one-hop question, or none: escrow and the payment gate asked
 * nobody, a grant from an agent nobody owned could hand on anything, and a database error while
 * reading an owner read as "no owner", which for a widening grant meant "today's rules apply".
 *
 * WHO CAN ANSWER, in the order checked:
 *   1. a bound owner — a live row in human_agent_bindings: someone signed for this exact agent
 *      (wallet-proven or proof-of-human, never flattened into one another; see assuranceOf).
 *   2. the operator's custodian — repid_agents.conservator_address, set only by the operator's
 *      minter, never by the public register route (that route stores a caller's
 *      conservator_address inside the constitution JSON, not in this column). Today that is the
 *      house fleet: one custodian over 12 minted agents [MEASURED 2026-10-07]. It is a weaker
 *      claim than a signature, and the result says so (`assurance: 'operator-assigned'`). Binding
 *      the house agents to a person retires it.
 *   3. through a grant chain — an agent nobody owns may act under a grant only while that
 *      grant's chain is live and connected, and the agent at its TOP has (1) or (2).
 *
 * FAILS CLOSED. Every read that errors returns `not_checked`, never "no owner"; the walk refuses a
 * cycle, a missing ancestor, a link that does not connect, or a chain past MAX_GRANT_DEPTH.
 * `not_checked` is a 503 at the routes, not a pass and not a denial of the agent's standing.
 *
 * COMPUTED EVERY TIME, NEVER STORED. That is what makes an unbind cut everything under the person
 * in one step: there is no cascade write to forget, because nothing below remembers the answer.
 */
import { db } from '../db';
import { SCOPE_OWNERSHIP, agentRefColumn } from './human-agent-binding';
import { type GrantRow, isChainLive, readGrantRow, sameEnd, walkAncestors } from './principal-grants';

export type RootKind = 'owner' | 'custodian';

export interface Anchor {
  kind: RootKind;
  /** The agent whose binding or custody this is. */
  agentId: string;
  /** The wallet that answers: the bound owner's, or the custodian's. */
  wallet: string;
  assurance: 'wallet-proven' | 'proof-of-human' | 'operator-assigned';
}

export interface AccountableRoot extends Anchor {
  /** The agent the question was asked about, resolved to its id. */
  subjectId: string;
  via: 'own-binding' | 'own-custodian' | 'grant-chain';
  /** Grant ids walked, nearest first; empty unless via grant-chain. */
  grantPath: string[];
}

export type RootCode =
  | 'no_root'
  | 'not_checked'
  | 'not_found'
  | 'ambiguous'
  | 'not_grantee'
  | 'chain_dead'
  | 'cycle'
  | 'too_deep';

export type RootFailure = { ok: false; code: RootCode; message: string };
export type RootResult = { ok: true; root: AccountableRoot } | RootFailure;
export type AnchorResult = { ok: true; anchor: Anchor } | RootFailure;

/** Everything the walk reads. Each method THROWS on a read error; null means "no such row". */
export interface RootReader {
  idsOf(ref: string): Promise<string[]>;
  bindingOf(agentId: string): Promise<{ wallet: string | null; kind: 'human_sbt' | 'builder' } | null>;
  custodianOf(agentId: string): Promise<string | null>;
  grant(id: string): Promise<GrantRow | null>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Who answers for this one agent directly: its bound owner, else the operator's custodian. */
export async function anchorOf(agentId: string, reader: RootReader = dbRootReader): Promise<AnchorResult> {
  let binding: Awaited<ReturnType<RootReader['bindingOf']>>;
  try {
    binding = await reader.bindingOf(agentId);
  } catch (e: unknown) {
    return { ok: false, code: 'not_checked', message: `could not read the owner of ${agentId}: ${errText(e)}` };
  }
  if (binding) {
    if (!binding.wallet) {
      return { ok: false, code: 'no_root', message: `${agentId} is bound, but no wallet is on record to answer for it` };
    }
    return {
      ok: true,
      anchor: {
        kind: 'owner',
        agentId,
        wallet: binding.wallet,
        assurance: binding.kind === 'human_sbt' ? 'proof-of-human' : 'wallet-proven',
      },
    };
  }
  let custodian: string | null;
  try {
    custodian = await reader.custodianOf(agentId);
  } catch (e: unknown) {
    return { ok: false, code: 'not_checked', message: `could not read the custodian of ${agentId}: ${errText(e)}` };
  }
  if (custodian) return { ok: true, anchor: { kind: 'custodian', agentId, wallet: custodian, assurance: 'operator-assigned' } };
  return { ok: false, code: 'no_root', message: `nobody has claimed ${agentId}, and no custodian answers for it` };
}

/** Resolve a ref (id or name) to exactly one agent id, or say why not. */
async function oneId(ref: string, reader: RootReader): Promise<{ ok: true; id: string } | RootFailure> {
  let ids: string[];
  try {
    ids = await reader.idsOf(ref);
  } catch (e: unknown) {
    return { ok: false, code: 'not_checked', message: `could not look up ${ref}: ${errText(e)}` };
  }
  if (ids.length === 0) return { ok: false, code: 'not_found', message: `no agent ${ref}` };
  if (ids.length > 1) return { ok: false, code: 'ambiguous', message: `more than one agent is named ${ref}; name it by its id` };
  return { ok: true, id: ids[0]! };
}

/** anchorOf for a ref that may be a name. Used by the unbind cut in principal-grants. */
export async function anchorOfRef(ref: string, reader: RootReader = dbRootReader): Promise<AnchorResult> {
  const id = await oneId(ref, reader);
  if (!id.ok) return id;
  return anchorOf(id.id, reader);
}

/**
 * The accountable root of `ref`. With `viaGrantId`, an agent nobody answers for directly may still
 * be answered for through that grant — the one it says it is acting under — but only if the
 * grant names it as grantee and the whole chain is live and connected.
 */
export async function resolveAccountableRoot(
  ref: string,
  opts: { viaGrantId?: string | null; reader?: RootReader; now?: Date } = {},
): Promise<RootResult> {
  const reader = opts.reader ?? dbRootReader;
  const id = await oneId(ref, reader);
  if (!id.ok) return id;

  const own = await anchorOf(id.id, reader);
  if (own.ok) {
    return {
      ok: true,
      root: { ...own.anchor, subjectId: id.id, via: own.anchor.kind === 'owner' ? 'own-binding' : 'own-custodian', grantPath: [] },
    };
  }
  if (own.code !== 'no_root' || !opts.viaGrantId) return own;

  let grant: GrantRow | null;
  try {
    grant = await reader.grant(opts.viaGrantId);
  } catch (e: unknown) {
    return { ok: false, code: 'not_checked', message: `could not read grant ${opts.viaGrantId}: ${errText(e)}` };
  }
  if (!grant) return { ok: false, code: 'not_found', message: `no grant ${opts.viaGrantId}` };
  if (!sameEnd(grant.grantee_agent_id, ref) && !sameEnd(grant.grantee_agent_id, id.id)) {
    return { ok: false, code: 'not_grantee', message: `grant ${grant.id} was granted to ${grant.grantee_agent_id}, not to ${ref}` };
  }
  const walk = await walkAncestors(grant, (gid) => reader.grant(gid));
  if (!walk.ok) return { ok: false, code: walk.code, message: walk.reason };
  const live = isChainLive(grant, walk.ancestors, opts.now);
  if (!live.live) return { ok: false, code: 'chain_dead', message: live.reason };

  const top = walk.ancestors.length ? walk.ancestors[walk.ancestors.length - 1]! : grant;
  const topAnchor = await anchorOfRef(top.grantor_agent_id, reader);
  if (!topAnchor.ok) {
    return {
      ok: false,
      code: topAnchor.code,
      message: `the agent at the top of grant ${grant.id}'s chain (${top.grantor_agent_id}) has no accountable root: ${topAnchor.message}`,
    };
  }
  return {
    ok: true,
    root: { ...topAnchor.anchor, subjectId: id.id, via: 'grant-chain', grantPath: [grant.id, ...walk.ancestors.map((a) => a.id)] },
  };
}

/** HTTP status for a refusal: not_checked is "we could not look" (503), everything else is a no (403). */
export function rootRefusalStatus(f: RootFailure): number {
  return f.code === 'not_checked' ? 503 : 403;
}

/** The reader the routes use. Every method throws on a database error. */
export const dbRootReader: RootReader = {
  async idsOf(ref) {
    const col = agentRefColumn(ref);
    const { data, error } = await db.from('repid_agents').select('id').eq(col, ref);
    if (error) throw new Error(error.message);
    return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
  },
  async bindingOf(agentId) {
    const { data, error } = await db
      .from('human_agent_bindings')
      .select('human_wallet, owner_kind')
      .eq('agent_id', agentId)
      .eq('scope', SCOPE_OWNERSHIP)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { human_wallet: string | null; owner_kind: string | null };
    return { wallet: row.human_wallet ?? null, kind: row.owner_kind === 'builder' ? 'builder' : 'human_sbt' };
  },
  async custodianOf(agentId) {
    const { data, error } = await db.from('repid_agents').select('conservator_address').eq('id', agentId).maybeSingle();
    if (error) throw new Error(error.message);
    const addr = (data as { conservator_address?: string | null } | null)?.conservator_address ?? null;
    return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : null;
  },
  grant: readGrantRow,
};
