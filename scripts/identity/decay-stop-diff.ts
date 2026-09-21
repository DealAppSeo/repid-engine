/**
 * C9 A3 — agents currently decaying who would STOP under bound-aware decay.
 * Synthetic roster by default. Does not read prod.
 */
import { whoWouldStopDecaying, type AgentKind } from '../../src/identity/kind-custody';

export interface RosterRow {
  id: string;
  kind: AgentKind;
  would_remove: number;
}

/** SYNTHETIC fixture — never prod agent ids. */
export const SYNTHETIC_ROSTER: RosterRow[] = [
  { id: '00000000-0000-4000-8000-0000000000d3', kind: 'ABT', would_remove: 40 },
  { id: '00000000-0000-4000-8000-0000000000d4', kind: 'DBT', would_remove: 40 },
  { id: '00000000-0000-4000-8000-0000000000d5', kind: 'SBT', would_remove: 0 },
  { id: '00000000-0000-4000-8000-0000000000d6', kind: 'IBT', would_remove: 12 },
];

export function decayStopDiff(roster: RosterRow[] = SYNTHETIC_ROSTER): RosterRow[] {
  return whoWouldStopDecaying(roster);
}

if (require.main === module) {
  const stop = decayStopDiff();
  console.log(JSON.stringify({ would_stop: stop.length, agents: stop }, null, 2));
}
