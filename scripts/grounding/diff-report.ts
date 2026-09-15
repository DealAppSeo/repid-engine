/**
 * C8 A6 — current score vs grounded rule, last-30-days window.
 * Default: synthetic roster (harness). Refuses a production source.
 */
import { GROUNDING_FLOOR_USD } from '../../src/scoring/grounding';

export interface AgentDiff {
  agent_id: string;
  current_repid: number;
  grounded_repid: number;
  delta: number;
}

export function diffGrounded(rows: Array<{ agent_id: string; current_repid: number; g_verified: 0 | 'low' | 'high'; delta: number }>): {
  moved: AgentDiff[];
  floor_usd: number;
} {
  const byAgent = new Map<string, AgentDiff>();
  for (const r of rows) {
    const cur = byAgent.get(r.agent_id) ?? {
      agent_id: r.agent_id,
      current_repid: 0,
      grounded_repid: 0,
      delta: 0,
    };
    cur.current_repid += r.delta;
    if (r.g_verified !== 0) cur.grounded_repid += r.delta;
    cur.delta = cur.grounded_repid - cur.current_repid;
    byAgent.set(r.agent_id, cur);
  }
  const moved = [...byAgent.values()].filter((a) => a.delta !== 0);
  return { moved, floor_usd: GROUNDING_FLOOR_USD };
}

if (require.main === module) {
  const synth = [
    { agent_id: '00000000-0000-4000-8000-0000000000aa', current_repid: 0, g_verified: 0 as const, delta: 25 },
    { agent_id: '00000000-0000-4000-8000-0000000000aa', current_repid: 0, g_verified: 'high' as const, delta: 10 },
  ];
  const r = diffGrounded(synth);
  console.log(JSON.stringify({ agents_moved: r.moved.length, floor_usd: r.floor_usd, moved: r.moved }, null, 2));
}
