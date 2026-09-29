/**
 * T12 heartbeat probe. The SQL names trinity_heartbeat.last_seen and is not executed.
 * Rows are injected by the caller. A missing or empty timestamp is NOT_CHECKED.
 * This module does not fetch, does not read the environment, and does not start a swarm.
 */

export const T12_HEARTBEAT_SQL =
  'select max(last_seen) as last_heartbeat_at from trinity_heartbeat';

export interface T12HeartbeatRow {
  last_heartbeat_at?: string | null;
}

export interface T12HeartbeatProbe {
  status: 'counted' | 'NOT_CHECKED';
  last_heartbeat_at: string | null;
}

export function probeT12Heartbeat(
  rows: readonly T12HeartbeatRow[] | null | undefined,
): T12HeartbeatProbe {
  const value = rows?.[0]?.last_heartbeat_at;
  if (typeof value === 'string' && value.length > 0) {
    return { status: 'counted', last_heartbeat_at: value };
  }
  return { status: 'NOT_CHECKED', last_heartbeat_at: null };
}
