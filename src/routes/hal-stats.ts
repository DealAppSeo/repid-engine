import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

// GET /hal/stats — public HAL production statistics across the FULL pipeline.
//
// CC1 Round 3 (2026-05-26): rewritten to surface all four canonical HAL source
// tables instead of just `hal_production_events` (which historically only
// captures the small Track-A production-events sample). The prior shape
// reported `totalInferences: 5, catchRate: 0` against the production-events
// table while the actual HAL surfaces (`hal_classifications`, `hal_audit_chain`,
// `peer_verification_queue`) carry thousands of events. This rewrite reports
// each surface honestly with lifetime + 24h windows.
//
// Public, no auth, read-only.
router.get('/hal/stats', async (_req: Request, res: Response) => {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  type CountResult = { lifetime: number | null; last_24h: number | null };
  const safeCount = async (table: string, hasCreatedAt: boolean): Promise<CountResult> => {
    try {
      const lifetimeQ = db.from(table).select('*', { count: 'exact', head: true });
      const last24hQ = hasCreatedAt
        ? db.from(table).select('*', { count: 'exact', head: true }).gte('created_at', since24h)
        : null;
      const [lt, l24]: any = await Promise.all([
        lifetimeQ,
        last24hQ ?? Promise.resolve({ count: null, error: null }),
      ]);
      return {
        lifetime: lt.error ? null : (lt.count ?? 0),
        last_24h: last24hQ ? (l24.error ? null : (l24.count ?? 0)) : null,
      };
    } catch {
      return { lifetime: null, last_24h: null };
    }
  };

  // peer_verification_queue: "pending" = completed_at IS NULL.
  const pvqPending = async (): Promise<number | null> => {
    try {
      const { count, error } = await db
        .from('peer_verification_queue')
        .select('*', { count: 'exact', head: true })
        .is('completed_at', null);
      return error ? null : (count ?? 0);
    } catch { return null; }
  };

  // Production events sample for latency + verdict signal (kept for backward
  // compatibility with the prior shape, but reframed as "production_events"
  // section rather than the headline totals).
  const productionSample = async () => {
    try {
      const { data, error } = await db
        .from('hal_production_events')
        .select('pcv_vetoed, total_latency_ms')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error || !data) {
        return { lifetime_in_sample: 0, caught_in_sample: 0, avg_latency_ms: null as number | null };
      }
      const total = data.length;
      const caught = data.filter((e: any) => e.pcv_vetoed === true).length;
      const totalLatency = data.reduce((s: number, e: any) => s + (Number(e.total_latency_ms) || 0), 0);
      const withLatency = data.filter((e: any) => Number(e.total_latency_ms) > 0).length;
      return {
        lifetime_in_sample: total,
        caught_in_sample: caught,
        avg_latency_ms: withLatency > 0 ? Math.round(totalLatency / withLatency) : null,
      };
    } catch {
      return { lifetime_in_sample: 0, caught_in_sample: 0, avg_latency_ms: null };
    }
  };

  const [classifications, auditChain, productionEvents, pvqPendingCount, sample] = await Promise.all([
    safeCount('hal_classifications', true),
    safeCount('hal_audit_chain', true),
    safeCount('hal_production_events', true),
    pvqPending(),
    productionSample(),
  ]);

  // Headline figures (snake_case, matching Round 3 spec).
  const total_inferences = classifications.lifetime ?? 0;
  const total_classifications = classifications.lifetime ?? 0;
  const audit_chain_length = auditChain.lifetime ?? 0;
  const peer_verification_queue_size = pvqPendingCount ?? 0;
  const last_24h_inferences = classifications.last_24h ?? 0;
  const last_24h_classifications = classifications.last_24h ?? 0;

  const isLive =
    (auditChain.last_24h ?? 0) > 0 ||
    (classifications.last_24h ?? 0) > 0 ||
    (productionEvents.last_24h ?? 0) > 0;

  res.json({
    // Headline counts — what a Magician running curl sees first.
    total_inferences,
    total_classifications,
    audit_chain_length,
    peer_verification_queue_size,
    last_24h_inferences,
    last_24h_classifications,

    // Per-table breakdown for the curious reader.
    breakdown: {
      hal_classifications: classifications,
      hal_audit_chain: auditChain,
      hal_production_events: {
        ...productionEvents,
        sample: { in_last_1000: sample.lifetime_in_sample, caught: sample.caught_in_sample },
      },
      peer_verification_queue: { pending: peer_verification_queue_size },
    },

    // Liveness + latency.
    isLive,
    avg_latency_ms: sample.avg_latency_ms, // measured from the most recent 1000 production events
    network: 'base-sepolia',
    last_updated: new Date().toISOString(),
  });
});

export default router;
