/**
 * PRACTICE LANE, slice P1 (Sean's GO 2026-10-07; the design is docs/PRACTICE_LANE.md in
 * DealAppSeo/trustshell).
 *
 * Everyone starts on paper. Real value may move only when four gates hold for a person and their
 * agent: bound both ways, has seen a Caught, has set a limit and a payee and stopped one, has
 * signed an acknowledgement. This file says, for one agent, which gates hold, from what can be
 * measured TODAY, and nothing else. It gates nothing yet: every value here is on the test network.
 *
 * THREE OUTCOMES PER GATE. VERIFIED: measured and true. FAILED: measured and not true yet.
 * NOT_CHECKED: there is no record to read, or the read failed. A gate that cannot be measured is
 * never passed, so the lane reads 'practice' until every gate is VERIFIED. No agent can reach that
 * today, because two gates have no record yet (the acknowledgement needs a table, P2; a Caught seen
 * by a signed-in owner needs P3). That is the honest answer, not a bug.
 *
 * READ-ONLY. Two database reads and, when there is an owner, one on-chain read of the USDC
 * allowance the owner signed for the agent's own wallet (the cap from Build D). Nothing is written.
 */
import { db } from '../db';
import { SCOPE_OWNERSHIP, agentRefColumn } from './human-agent-binding';
import { SPEND_CHAIN_ID, USDC_DECIMALS, type SpendChain } from './agent-spend';

export type GateStatus = 'VERIFIED' | 'FAILED' | 'NOT_CHECKED';

export interface GatePart {
  id: string;
  status: GateStatus;
  detail: string;
}

export interface Gate {
  id: 'bound_both_ways' | 'seen_a_caught' | 'limit_payee_stop' | 'signed_acknowledgement';
  title: string;
  status: GateStatus;
  detail: string;
  parts?: GatePart[];
}

export interface LaneReport {
  agent: { id: string; name: string | null };
  lane: 'practice' | 'eligible';
  network: string;
  gates: Gate[];
  summary: Record<GateStatus, number>;
  measured_at: string;
  spec: string;
}

export const LANE_SPEC_URL = 'https://github.com/DealAppSeo/trustshell/blob/main/docs/PRACTICE_LANE.md';

/** What the lane reads. Each method THROWS on a read error; null means "no such row". */
export interface LaneReader {
  agents(ref: string): Promise<Array<{ id: string; agent_name: string | null; wallet_address: string | null }>>;
  binding(agentId: string): Promise<{ human_wallet: string | null } | null>;
}

export const dbLaneReader: LaneReader = {
  async agents(ref) {
    const { data, error } = await db
      .from('repid_agents')
      .select('id, agent_name, wallet_address')
      .eq(agentRefColumn(ref), ref);
    if (error) throw new Error(error.message);
    return (data as Array<{ id: string; agent_name: string | null; wallet_address: string | null }> | null) ?? [];
  },
  async binding(agentId) {
    const { data, error } = await db
      .from('human_agent_bindings')
      .select('human_wallet')
      .eq('agent_id', agentId)
      .eq('scope', SCOPE_OWNERSHIP)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { human_wallet: string | null } | null) ?? null;
  },
};

/** FAILED if any part is measured false; else NOT_CHECKED if any part is unmeasured; else VERIFIED. */
export function combine(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('FAILED')) return 'FAILED';
  if (statuses.includes('NOT_CHECKED')) return 'NOT_CHECKED';
  return 'VERIFIED';
}

/** 'eligible' only when every gate is VERIFIED. Anything unmeasured keeps the lane on paper. */
export function laneOf(gates: Gate[]): 'practice' | 'eligible' {
  return gates.length > 0 && gates.every((g) => g.status === 'VERIFIED') ? 'eligible' : 'practice';
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const usdc = (units: bigint) => {
  const s = units.toString().padStart(USDC_DECIMALS + 1, '0');
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`.replace(/\.?0+$/, '');
};

export type LaneResult =
  | { ok: true; report: LaneReport }
  | { ok: false; status: 404 | 409 | 503; error: string; message: string };

export async function laneReport(
  ref: string,
  deps: { reader?: LaneReader; chain?: SpendChain | null; now?: Date } = {},
): Promise<LaneResult> {
  const reader = deps.reader ?? dbLaneReader;

  let rows: Awaited<ReturnType<LaneReader['agents']>>;
  try {
    rows = await reader.agents(ref);
  } catch (e: unknown) {
    return { ok: false, status: 503, error: 'not_checked', message: `could not look up ${ref}: ${errText(e)}` };
  }
  if (rows.length === 0) return { ok: false, status: 404, error: 'agent_not_found', message: `no agent ${ref}` };
  if (rows.length > 1) return { ok: false, status: 409, error: 'ambiguous', message: `more than one agent is named ${ref}; use its id` };
  const agent = rows[0]!;

  // Gate 1: bound both ways. Since 2026-10-07 a live binding needs BOTH the owner's wallet
  // signature and the agent's own key (human-agent-binding.ts, "TWO SIDES, NOT ONE").
  let ownerWallet: string | null = null;
  let bound: Gate;
  try {
    const b = await reader.binding(agent.id);
    ownerWallet = b?.human_wallet ?? null;
    bound = b
      ? { id: 'bound_both_ways', title: 'Bound both ways', status: 'VERIFIED', detail: 'A person signed for this agent with their wallet, and the agent proved it holds its own key.' }
      : { id: 'bound_both_ways', title: 'Bound both ways', status: 'FAILED', detail: 'Nobody has claimed this agent yet. Claim it on /bind with your wallet.' };
  } catch (e: unknown) {
    bound = { id: 'bound_both_ways', title: 'Bound both ways', status: 'NOT_CHECKED', detail: `Could not read who owns this agent: ${errText(e)}` };
  }

  // Gate 2: seen a Caught. /check is anonymous, so nothing ties a Caught to this agent's owner.
  const caught: Gate = {
    id: 'seen_a_caught',
    title: 'Has seen a Caught',
    status: 'NOT_CHECKED',
    detail: 'Checks are anonymous today, so nothing records that this owner has watched a false claim get caught.',
  };

  // Gate 3: a limit and a payee set, and one stopped. Only the limit can be read today.
  const limit = await limitPart(agent.wallet_address, ownerWallet, bound.status, deps.chain ?? null);
  const parts: GatePart[] = [
    limit,
    { id: 'payee', status: 'NOT_CHECKED', detail: 'Payees do not exist yet. They come with the one migration Sean approves (S6).' },
    { id: 'stopped_once', status: 'NOT_CHECKED', detail: 'No record of a stop is kept yet.' },
  ];
  const limitGate: Gate = {
    id: 'limit_payee_stop',
    title: 'Has set a limit and a payee, and stopped one',
    status: combine(parts.map((p) => p.status)),
    detail: 'The limit is the USDC allowance the owner signed for the agent\'s own wallet, read from the chain.',
    parts,
  };

  // Gate 4: a signed acknowledgement. The signing exists; nothing stores it yet.
  const ack: Gate = {
    id: 'signed_acknowledgement',
    title: 'Has signed an acknowledgement',
    status: 'NOT_CHECKED',
    detail: 'Nothing stores the acknowledgement yet. It comes with the same migration.',
  };

  const gates = [bound, caught, limitGate, ack];
  const summary: Record<GateStatus, number> = { VERIFIED: 0, FAILED: 0, NOT_CHECKED: 0 };
  for (const g of gates) summary[g.status] += 1;
  return {
    ok: true,
    report: {
      agent: { id: agent.id, name: agent.agent_name },
      lane: laneOf(gates),
      network: 'Base Sepolia (84532), a test network: no real funds',
      gates,
      summary,
      measured_at: (deps.now ?? new Date()).toISOString(),
      spec: LANE_SPEC_URL,
    },
  };
}

async function limitPart(
  agentWallet: string | null,
  ownerWallet: string | null,
  boundStatus: GateStatus,
  chain: SpendChain | null,
): Promise<GatePart> {
  if (boundStatus !== 'VERIFIED' || !ownerWallet) {
    return { id: 'limit', status: 'NOT_CHECKED', detail: 'A limit is set from the owner\'s wallet, so it can be read only once the agent is claimed.' };
  }
  if (!agentWallet) return { id: 'limit', status: 'FAILED', detail: 'This agent has no wallet of its own, so no limit can be set for it.' };
  if (!chain) return { id: 'limit', status: 'NOT_CHECKED', detail: 'No chain connection is configured here.' };
  try {
    const id = await chain.chainId();
    if (id !== SPEND_CHAIN_ID) return { id: 'limit', status: 'NOT_CHECKED', detail: `The chain answered with id ${id}, not Base Sepolia (84532).` };
    const allowance = await chain.allowance(ownerWallet, agentWallet);
    return allowance > 0n
      ? { id: 'limit', status: 'VERIFIED', detail: `The owner allows this agent up to ${usdc(allowance)} test USDC.` }
      : { id: 'limit', status: 'FAILED', detail: 'No limit is set (or it was stopped at 0). Set one on /spend.' };
  } catch (e: unknown) {
    return { id: 'limit', status: 'NOT_CHECKED', detail: `Could not read the allowance from the chain: ${errText(e)}` };
  }
}
