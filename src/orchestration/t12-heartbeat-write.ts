/**
 * One trinity_heartbeat insert, and only when the free-wave flag is the exact string true.
 * The caller supplies exec. This module does not open a client and does not call a host.
 */
import { T12_FREE_WAVE_ORDER, t12FreeWaveEnabled } from './t12-free-wave';

export const T12_HEARTBEAT_INSERT_SQL =
  'insert into trinity_heartbeat (last_seen) values (now())';

export function writeT12Heartbeat(
  env: Record<string, string | undefined>,
  exec: (sql: string) => void,
): { written: number; order: readonly string[] } {
  if (!t12FreeWaveEnabled(env)) return { written: 0, order: [] };
  exec(T12_HEARTBEAT_INSERT_SQL);
  return { written: 1, order: T12_FREE_WAVE_ORDER };
}
