/**
 * Builder-owned agent creation.
 *
 * Creates a new repid_agents row with builder_id linked, starting RepID
 * 1000 (EARNING_AUTONOMY tier floor) and wisdom/character at 1000.
 *
 * erc8004_address is deterministic-ish: '0xAGENT_' + first 34 hex of
 * sha256(agent_name || builder_id || timestamp). Same shape rule as the
 * '0xT0KEN' / '0xEMAIL' addresses — visible by inspection that this is
 * a registry id, not a real EVM address.
 *
 * Side effects:
 *   - Increments builders.agent_count.
 *   - Touches builders.last_active_at.
 *   - Emits audit row.
 */

import { createHash } from 'crypto';
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

const STARTING_REPID = 1000;
const STARTING_WISDOM = 1000;
const STARTING_CHARACTER = 1000;

export interface CreateAgentInput {
  builderId: string;
  agentName: string;
  agentRole?: string;
}

export interface CreateAgentResult {
  ok: boolean;
  agent_id?: string;
  agent_address?: string;
  initial_repid?: number;
  error?: string;
}

const NAME_RE = /^[A-Za-z0-9 _-]{2,64}$/;

export function deriveAgentAddress(name: string, builderId: string): string {
  const hash = createHash('sha256').update(`${name}|${builderId}|${Date.now()}`).digest('hex');
  return '0xAGENT_' + hash.slice(0, 34);
}

export async function createBuilderAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
  if (!NAME_RE.test(input.agentName)) {
    return { ok: false, error: 'agent_name must be 2-64 chars, alphanumeric/space/underscore/dash' };
  }

  // Confirm builder exists.
  const { data: builder } = await db
    .from('builders')
    .select('id, agent_count')
    .eq('id', input.builderId)
    .maybeSingle();
  if (!builder) {
    return { ok: false, error: 'builder not found' };
  }

  const erc8004 = deriveAgentAddress(input.agentName, input.builderId);

  const { data, error } = await db
    .from('repid_agents')
    .insert({
      agent_name: input.agentName,
      builder_id: input.builderId,
      current_repid: STARTING_REPID,
      wisdom_score: STARTING_WISDOM,
      character_score: STARTING_CHARACTER,
      erc8004_address: erc8004,
      last_active_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'agent insert failed' };
  }

  await db
    .from('builders')
    .update({
      agent_count: Number(builder.agent_count ?? 0) + 1,
      last_active_at: new Date().toISOString(),
    })
    .eq('id', input.builderId);

  await emitAuditEvent({
    event_type: 'builder_agent_created',
    source_table: 'repid_agents',
    source_id: data.id,
    payload: {
      agent_id: data.id,
      agent_name: input.agentName,
      agent_role: input.agentRole ?? null,
      builder_id: input.builderId,
      erc8004_address: erc8004,
      initial_repid: STARTING_REPID,
    },
  });

  return {
    ok: true,
    agent_id: data.id,
    agent_address: erc8004,
    initial_repid: STARTING_REPID,
  };
}
