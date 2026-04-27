/**
 * Character score — mission-aligned action delta.
 *
 * Four event types, each with a fixed delta (within bounds [100, 2000]):
 *   trade_with_low_repid        +5    (only if counterparty.repid < self.repid)
 *   attestation_to_low_repid    +10
 *   underserved_domain_action   +15   (only if domainTradeCount < 100)
 *   agent_abandonment           -20
 *
 * Bound clamps applied at write time. History row written before the
 * delta is applied so a downstream replay can reconstruct.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

export const C_FLOOR = 100;
export const C_CEILING = 2000;
export const UNDERSERVED_DOMAIN_THRESHOLD = 100;

export type CharacterEventType =
  | 'trade_with_low_repid'
  | 'attestation_to_low_repid'
  | 'underserved_domain_action'
  | 'agent_abandonment';

export interface RecordCharacterEventInput {
  agentId: string;
  eventType: CharacterEventType;
  counterpartyRepId?: number;
  agentSelfRepId?: number;
  domainTradeCount?: number;
}

export interface CharacterUpdateResult {
  agent_id: string;
  old_character: number;
  new_character: number;
  delta: number;
  reason: CharacterEventType;
}

const WEIGHTS: Record<CharacterEventType, number> = {
  trade_with_low_repid: 1.0,
  attestation_to_low_repid: 2.0,
  underserved_domain_action: 3.0,
  agent_abandonment: -4.0,
};

export function deltaFor(args: RecordCharacterEventInput): number {
  switch (args.eventType) {
    case 'trade_with_low_repid':
      if (args.counterpartyRepId !== undefined && args.agentSelfRepId !== undefined && args.counterpartyRepId < args.agentSelfRepId) {
        return 5;
      }
      return 0;
    case 'attestation_to_low_repid':
      return 10;
    case 'underserved_domain_action':
      if (args.domainTradeCount !== undefined && args.domainTradeCount < UNDERSERVED_DOMAIN_THRESHOLD) {
        return 15;
      }
      return 0;
    case 'agent_abandonment':
      return -20;
  }
}

export async function getCurrentCharacter(agentId: string): Promise<number> {
  const { data } = await db
    .from('repid_agents')
    .select('character_score')
    .eq('id', agentId)
    .maybeSingle();
  return Number(data?.character_score ?? 1000);
}

export async function recordCharacterEvent(args: RecordCharacterEventInput): Promise<CharacterUpdateResult> {
  const helpedLow =
    args.counterpartyRepId !== undefined &&
    args.agentSelfRepId !== undefined &&
    args.counterpartyRepId < args.agentSelfRepId;

  await db.from('agent_character_history').insert({
    agent_id: args.agentId,
    action_type: args.eventType,
    helped_low_repid_party: helpedLow,
    mission_alignment_weight: WEIGHTS[args.eventType] ?? 0,
  });

  const current = await getCurrentCharacter(args.agentId);
  const delta = deltaFor(args);
  const newCharacter = Math.max(C_FLOOR, Math.min(C_CEILING, current + delta));

  await db.from('repid_agents').update({
    character_score: newCharacter,
  }).eq('id', args.agentId);

  await emitAuditEvent({
    event_type: 'character_update',
    source_table: 'repid_agents',
    source_id: args.agentId,
    payload: {
      agent_id: args.agentId,
      old: current,
      new: newCharacter,
      delta,
      reason: args.eventType,
    },
  });

  return {
    agent_id: args.agentId,
    old_character: current,
    new_character: newCharacter,
    delta,
    reason: args.eventType,
  };
}
