/**
 * Read-only T12 last-seen heartbeat helper.
 *
 * Only attempts a read when T12_FREE_WAVE is the exact string true. A missing or
 * empty timestamp, a thrown callback, or a flag in any other state all return
 * NOT_CHECKED. This module does not fetch, does not call a host, and does not
 * start a swarm.
 */

import {
  probeT12Heartbeat,
  T12_HEARTBEAT_SQL,
  type T12HeartbeatRow,
  type T12HeartbeatProbe,
} from './t12-heartbeat-probe';
import { t12FreeWaveEnabled } from './t12-free-wave';

export { T12_HEARTBEAT_SQL };

export type T12HeartbeatLastResult = T12HeartbeatProbe;

export function getT12HeartbeatLast(
  env: Record<string, string | undefined>,
  query: (sql: string) => readonly T12HeartbeatRow[] | null | undefined,
): T12HeartbeatLastResult {
  if (!t12FreeWaveEnabled(env)) {
    return { status: 'NOT_CHECKED', last_heartbeat_at: null };
  }

  try {
    const rows = query(T12_HEARTBEAT_SQL);
    return probeT12Heartbeat(rows);
  } catch {
    return { status: 'NOT_CHECKED', last_heartbeat_at: null };
  }
}
