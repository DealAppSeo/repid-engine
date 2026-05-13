/**
 * Probe: x402 settlement activity.
 * PASS: ≥1 successful settlement in 24h.
 * AMBER: 0 settlements, no failures (idle).
 * RED: failures without successes (broken).
 */
import { getDb, ProbeResult, ProbeStatus } from './_shared';

export async function probeX402Settlements(): Promise<ProbeResult> {
  const db = getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count: settlements24h } = await db
    .from('x402_settlements').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);

  // x402_settlement_failures may or may not exist; probe defensively
  let unresolvedFailures: number = 0;
  try {
    const { count } = await db
      .from('x402_settlement_failures').select('*', { count: 'exact', head: true })
      .is('resolved_at', null);
    unresolvedFailures = count ?? 0;
  } catch {
    // table may be missing if Gemini Sprint 3 not merged; treat as 0
    unresolvedFailures = 0;
  }

  const { data: latest } = await db
    .from('x402_settlements').select('created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  // repid_events should also reflect settlement: x402_inbound_settled / x402_outbound_settled
  const { count: postSettlementRepidEvents } = await db
    .from('repid_events').select('*', { count: 'exact', head: true })
    .in('event_type', ['x402_inbound_settled', 'x402_outbound_settled'])
    .gte('created_at', since24h);

  let status: ProbeStatus;
  if ((settlements24h ?? 0) >= 1) status = 'GREEN';
  else if (unresolvedFailures > 0) status = 'RED';
  else status = 'AMBER'; // idle but not broken

  return {
    name: 'x402-settlements',
    status,
    metrics: {
      settlements_24h: settlements24h ?? 0,
      unresolved_failures: unresolvedFailures,
      last_settlement_at: (latest as any)?.created_at ?? null,
      post_settlement_repid_events_24h: postSettlementRepidEvents ?? 0,
    },
  };
}

if (require.main === module) {
  probeX402Settlements().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
