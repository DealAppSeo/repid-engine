/**
 * kind-custody.ts — agent kind + custody state machine (LOOP C7, local/code).
 *
 * Kinds: DBT | ABT | SBT | IBT. CBT is NOT a kind — charitable is a revocable
 * flag on IBT. Bound is derived (kind !== 'DBT'), never hand-set.
 *
 * Prod schema/backfill is Sean-gated DDL. This module is the enforceable
 * machine C9/C10 branch on; it writes only through an injected log, never
 * through a hidden prod client.
 */
import { createHash, randomBytes } from 'node:crypto';

export type AgentKind = 'DBT' | 'ABT' | 'SBT' | 'IBT';
export type CustodyReason = 'claim' | 'rebind' | 'personhood' | 'genesis';

export interface CustodyRow {
  agent_id: string;
  custodian_id: string;
  valid_from: string;
  valid_to: string | null;
  reason: CustodyReason;
}

export interface AgentIdentity {
  id: string;
  kind: AgentKind;
  custodian_id: string | null;
  charitable_verified?: boolean;
  pairing_code_hash?: string | null;
  pairing_expires_at?: string | null;
  pairing_used?: boolean;
}

export class IllegalTransitionError extends Error {
  constructor(public readonly from: AgentKind, public readonly to: string, public readonly why: string) {
    super(`illegal_transition: ${from} -> ${to}: ${why}`);
    this.name = 'IllegalTransitionError';
  }
}

export function isBoundKind(kind: AgentKind): boolean {
  return kind !== 'DBT';
}

/** C9 A3: currently decaying AND bound → would stop under the new rule. */
export function whoWouldStopDecaying<T extends { id: string; kind: AgentKind; would_remove: number }>(
  roster: T[],
): T[] {
  return roster.filter((r) => isBoundKind(r.kind) && r.would_remove > 0);
}

export function derivedBound(agent: Pick<AgentIdentity, 'kind'>): boolean {
  return isBoundKind(agent.kind);
}

export function assertCustodianInvariant(agent: AgentIdentity): void {
  if (isBoundKind(agent.kind) && !agent.custodian_id) {
    throw new IllegalTransitionError(agent.kind, agent.kind, 'bound_kind_null_custodian');
  }
}

export function hashPairingCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function issuePairingCode(now = new Date(), ttlMs = 24 * 60 * 60 * 1000): {
  code: string;
  hash: string;
  expires_at: string;
} {
  const code = randomBytes(16).toString('hex');
  return {
    code,
    hash: hashPairingCode(code),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export interface CustodyLog {
  rows: CustodyRow[];
  append(row: CustodyRow): void;
}

export function createMemoryCustodyLog(seed: CustodyRow[] = []): CustodyLog {
  const rows = seed.slice();
  return {
    get rows() {
      return rows;
    },
    append(row) {
      rows.push({ ...row });
    },
  };
}

function closeOpen(log: CustodyLog, agentId: string, at: string): void {
  for (const r of log.rows) {
    if (r.agent_id === agentId && r.valid_to === null) r.valid_to = at;
  }
}

export function claimDbtToAbt(params: {
  agent: AgentIdentity;
  custodian: AgentIdentity;
  pairingCode: string;
  now?: Date;
  log: CustodyLog;
}): AgentIdentity {
  if (params.agent.kind !== 'DBT') {
    throw new IllegalTransitionError(params.agent.kind, 'ABT', 'claim_requires_dbt');
  }
  if (params.custodian.kind !== 'SBT' && params.custodian.kind !== 'IBT') {
    throw new IllegalTransitionError(params.agent.kind, 'ABT', 'claim_requires_sbt_or_ibt_custodian');
  }
  const now = params.now ?? new Date();
  if (!params.agent.pairing_code_hash) {
    throw new IllegalTransitionError('DBT', 'ABT', 'no_pairing_code');
  }
  if (params.agent.pairing_used) {
    throw new IllegalTransitionError('DBT', 'ABT', 'pairing_code_reused');
  }
  if (params.agent.pairing_expires_at && now.toISOString() > params.agent.pairing_expires_at) {
    throw new IllegalTransitionError('DBT', 'ABT', 'pairing_code_expired');
  }
  if (hashPairingCode(params.pairingCode) !== params.agent.pairing_code_hash) {
    throw new IllegalTransitionError('DBT', 'ABT', 'pairing_code_mismatch');
  }

  const at = now.toISOString();
  closeOpen(params.log, params.agent.id, at);
  params.log.append({
    agent_id: params.agent.id,
    custodian_id: params.custodian.id,
    valid_from: at,
    valid_to: null,
    reason: 'claim',
  });

  const next: AgentIdentity = {
    ...params.agent,
    kind: 'ABT',
    custodian_id: params.custodian.id,
    pairing_used: true,
  };
  assertCustodianInvariant(next);
  return next;
}

export function personhoodStepUp(params: {
  agent: AgentIdentity;
  now?: Date;
  log: CustodyLog;
  /** Same-token flip only from zero-history DBT. */
  historyEventCount: number;
}): AgentIdentity {
  if (params.agent.kind !== 'DBT') {
    throw new IllegalTransitionError(params.agent.kind, 'SBT', 'personhood_requires_dbt');
  }
  if (params.historyEventCount > 0) {
    throw new IllegalTransitionError('DBT', 'SBT', 'same_token_flip_requires_zero_history');
  }
  const at = (params.now ?? new Date()).toISOString();
  const self = params.agent.id;
  closeOpen(params.log, params.agent.id, at);
  params.log.append({
    agent_id: params.agent.id,
    custodian_id: self,
    valid_from: at,
    valid_to: null,
    reason: 'personhood',
  });
  const next: AgentIdentity = { ...params.agent, kind: 'SBT', custodian_id: self };
  assertCustodianInvariant(next);
  return next;
}

export function rebindAbt(params: {
  agent: AgentIdentity;
  newCustodian: AgentIdentity;
  now?: Date;
  log: CustodyLog;
}): AgentIdentity {
  if (params.agent.kind !== 'ABT') {
    throw new IllegalTransitionError(params.agent.kind, 'ABT', 'rebind_requires_abt');
  }
  if (params.newCustodian.kind !== 'SBT' && params.newCustodian.kind !== 'IBT') {
    throw new IllegalTransitionError('ABT', 'ABT', 'rebind_requires_sbt_or_ibt_custodian');
  }
  const at = (params.now ?? new Date()).toISOString();
  closeOpen(params.log, params.agent.id, at);
  params.log.append({
    agent_id: params.agent.id,
    custodian_id: params.newCustodian.id,
    valid_from: at,
    valid_to: null,
    reason: 'rebind',
  });
  const next: AgentIdentity = { ...params.agent, kind: 'ABT', custodian_id: params.newCustodian.id };
  assertCustodianInvariant(next);
  return next;
}

export function illegalAbandonToDbt(agent: AgentIdentity): never {
  throw new IllegalTransitionError(agent.kind, 'DBT', 'abt_sbt_ibt_cannot_become_dbt');
}

export function illegalNullCustodian(agent: AgentIdentity): never {
  throw new IllegalTransitionError(agent.kind, agent.kind, 'bound_kind_null_custodian');
}
