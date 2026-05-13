/**
 * Probe: Trinity swarm liveness via trinity_swarm_health view (Sprint 6).
 * PASS: 12 green.
 * AMBER: ≥1 red AND ≥1 green (partial wake-up in progress).
 * RED: 12 red.
 */
import { getDb, ProbeResult, ProbeStatus } from './_shared';

export async function probeTrinitySwarm(): Promise<ProbeResult> {
  const db = getDb();

  const { data: rows } = await db
    .from('trinity_swarm_health')
    .select('agent_name, status_color, heartbeat_last_seen, minutes_since_last_seen');

  const all = (rows ?? []) as any[];
  let green = 0, yellow = 0, red = 0;
  for (const r of all) {
    if (r.status_color === 'green') green++;
    else if (r.status_color === 'yellow') yellow++;
    else red++;
  }

  let status: ProbeStatus;
  if (green === 12) status = 'GREEN';
  else if (green >= 1 && red >= 1) status = 'AMBER';
  else status = 'RED';

  return {
    name: 'trinity-swarm',
    status,
    metrics: {
      green_count: green,
      yellow_count: yellow,
      red_count: red,
      agents: all.map((r: any) => ({
        agent: r.agent_name,
        color: r.status_color,
        mins_since: r.minutes_since_last_seen,
      })),
    },
  };
}

if (require.main === module) {
  probeTrinitySwarm().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
