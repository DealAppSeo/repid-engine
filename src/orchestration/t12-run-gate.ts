/**
 * T12 runs only when three local facts agree.
 * The flag argument is the exact string true, the heartbeat text is SQL
 * against trinity_heartbeat, and the injected task row is claimed.
 * This module does not fetch, does not read the environment, and does not
 * start a swarm.
 */
import { t12FreeWaveEnabled, t12FreeWaveOrder } from './t12-free-wave';

export const T12_HEARTBEAT_SQL =
  'select max(last_seen) as last_heartbeat_at from trinity_heartbeat';

export interface T12ClaimRow {
  claimed_at?: string | null;
  claimed_by?: string | null;
}

export type T12RunReason = 'allowed' | 'flag_off' | 'heartbeat_not_sql' | 'task_not_claimed';

export interface T12RunDecision {
  allowed: boolean;
  reason: T12RunReason;
  order: readonly string[];
}

function filled(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function t12HeartbeatIsSql(sql: string | null | undefined): boolean {
  if (typeof sql !== 'string') return false;
  const text = sql.toLowerCase();
  if (text.includes('http') || text.includes('fetch')) return false;
  return text.includes('select') && text.includes('trinity_heartbeat');
}

export function t12TaskClaimed(row: T12ClaimRow | null | undefined): boolean {
  if (!row) return false;
  return filled(row.claimed_at) || filled(row.claimed_by);
}

export function t12RunAllowed(input: {
  env?: Record<string, string | undefined>;
  heartbeatSql?: string | null;
  task?: T12ClaimRow | null;
}): T12RunDecision {
  const env = input.env ?? {};
  if (!t12FreeWaveEnabled(env)) {
    return { allowed: false, reason: 'flag_off', order: [] };
  }
  if (!t12HeartbeatIsSql(input.heartbeatSql)) {
    return { allowed: false, reason: 'heartbeat_not_sql', order: [] };
  }
  if (!t12TaskClaimed(input.task)) {
    return { allowed: false, reason: 'task_not_claimed', order: [] };
  }
  return { allowed: true, reason: 'allowed', order: t12FreeWaveOrder(env) };
}
