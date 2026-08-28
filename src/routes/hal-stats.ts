import { Router, Request, Response } from 'express';
import { db } from '../db';
import { buildFactCheckProviders, auditFamilyIndependence } from '../hal/fact-check';

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

  const getExternalBenchmark = async () => {
    try {
      const { data: runs, error: runsErr } = await db
        .from('hal_external_validation_runs')
        .select('test_case_id, hal_decision, run_id, run_at')
        .order('run_at', { ascending: false });

      if (runsErr || !runs || runs.length === 0) {
        return null;
      }

      const latestRunId = runs[0]!.run_id;
      const latestRunRuns = runs.filter((r: any) => r.run_id === latestRunId);

      const { data: cases, error: casesErr } = await db
        .from('hal_test_cases')
        .select('id, expected_hallucination');

      if (casesErr || !cases) {
        return null;
      }

      const caseMap = new Map<string, boolean>(cases.map((c: any) => [c.id, c.expected_hallucination]));

      let tp = 0, fp = 0, tn = 0, fn = 0;
      for (const r of latestRunRuns) {
        const expected = caseMap.get(r.test_case_id);
        if (expected === undefined) continue;

        const isVetoed = r.hal_decision === 'vetoed';
        if (expected === true) {
          if (isVetoed) tp++;
          else fn++;
        } else {
          if (isVetoed) fp++;
          else tn++;
        }
      }

      const precision = tp / (tp + fp || 1);
      const recall = tp / (tp + fn || 1);
      const f1 = (2 * precision * recall) / (precision + recall || 1);
      const accuracy = (tp + tn) / (tp + fp + tn + fn || 1);

      return {
        run_id: latestRunId,
        measured_at: latestRunRuns[0]!.run_at,
        corpus_size: latestRunRuns.length,
        metrics: {
          tp, fp, tn, fn,
          precision: +(precision * 100).toFixed(2),
          recall: +(recall * 100).toFixed(2),
          f1_score: +(f1 * 100).toFixed(2),
          accuracy: +(accuracy * 100).toFixed(2),
        },
        path: 'fact-check-quorum (strictness 2)',

        // AS MEASURED, past tense, deliberately. These figures come from one dated run,
        // and BOTH models named below have since been retired by their vendors:
        // Groq shut down `llama-3.1-8b-instant` on 2026-08-16, and Cerebras reports
        // `zai-glm-4.7` as `model_archived_error`. Neither can be called today.
        //
        // Stating the configuration in the present tense implied a quorum that is
        // currently running. It is not, and `npm run hal:score-external` can no longer
        // reproduce these numbers — it would fail on both members. A published metric
        // whose reproduction command does not reproduce is the exact debt this codebase
        // keeps paying: the caveat has to travel WITH the number, not live in someone's
        // memory of it.
        quorum_configuration_as_measured:
          'Groq (llama-3.1-8b-instant) + Cerebras (zai-glm-4.7) [DeepSeek enabled but simulated-throttled]',

        // Age is computed here rather than left to the reader to subtract from
        // `measured_at`. Same reasoning as the leaderboard: a date the reader has to do
        // arithmetic on is a date most readers do not check.
        measurement_age_days: Math.floor(
          (Date.now() - new Date(latestRunRuns[0]!.run_at).getTime()) / 86_400_000,
        ),

        // Three states, not two. `false` here is a FACT about tooling availability, not
        // a claim that the measurement was wrong — the run happened and its numbers
        // stand; what has lapsed is our ability to re-run it unchanged.
        reproducible_today: false,
        reproducibility_note:
          'Both quorum members were retired by their vendors after this run. The command below will not reproduce these figures until the quorum is repointed at live models.',
        reproduction_command: 'npm run hal:score-external',
      };
    } catch {
      return null;
    }
  };

  const [classifications, auditChain, productionEvents, pvqPendingCount, peerVerification, sample, externalBenchmark] = await Promise.all([
    safeCount('hal_classifications', true),
    safeCount('hal_audit_chain', true),
    safeCount('hal_production_events', true),
    pvqPending(),
    safeCount('peer_verification_queue', true), // total (all statuses) + 24h growth
    productionSample(),
    getExternalBenchmark(),
  ]);

  // Headline figures (snake_case, matching Round 3 spec).
  const total_inferences = classifications.lifetime ?? 0;
  const total_classifications = classifications.lifetime ?? 0;
  const audit_chain_length = auditChain.lifetime ?? 0;
  const peer_verification_queue_size = pvqPendingCount ?? 0;
  // Total peer-verifications ever recorded (all statuses), for the public
  // "N checks and counting" copy — distinct from the *pending* queue size.
  const peer_verification_total = peerVerification.lifetime ?? 0;
  const peer_verification_last_24h = peerVerification.last_24h ?? 0;
  const last_24h_inferences = classifications.last_24h ?? 0;
  const last_24h_classifications = classifications.last_24h ?? 0;

  const isLive =
    (auditChain.last_24h ?? 0) > 0 ||
    (classifications.last_24h ?? 0) > 0 ||
    (productionEvents.last_24h ?? 0) > 0;

  // Cross-family quorum shape — the SBFA differentiator, surfaced for the
  // public "independent cross-examination" card. Families are generic
  // lineage names (llama, glm, …), not provider secrets.
  //
  // THIS COUNTED THE WRONG THING UNTIL 2026-08-28, and it was a false claim on a public
  // surface. It reported `buildFactCheckProviders().length` — the CONFIGURED set — as though
  // it were the number of independent families cross-examining a claim. Measured on that day:
  // this endpoint said 6 families including `glm`, while a live evaluate on the same service
  // answered with 4 and reported glm's provider failing every call on a vendor-archived model.
  // The consumer renders this number as "N families cross-examine every claim", so the site
  // was advertising verification that was not happening.
  //
  // A configured provider is a provider we ASKED. Only a provider that answered is a voice in
  // the quorum, and the difference is exactly what a trust product may not blur.
  //
  // THREE OUTCOMES, NEVER TWO. Quiet periods are real — an empty window means "nobody called
  // HAL recently", NOT "nothing works" — so an absent measurement falls back to the configured
  // set and says so in `basis`. Reporting 0 families during a quiet hour would be the same
  // error pointed the other way.
  let quorum = { providers: 0, families: 0, family_names: [] as string[] };
  let quorumHealth: Record<string, unknown> = { basis: 'unavailable' };
  try {
    const cfgs = buildFactCheckProviders();
    const configured = auditFamilyIndependence(cfgs);

    // Which providers actually ANSWERED in the window. Read from the call ledger rather than
    // re-probing: a probe costs a request per provider and answers a different question
    // ("could it work now") than the one the card makes ("is it working").
    const { data: rows, error } = await db
      .from('llm_call_log')
      .select('provider, status')
      .eq('task_hint', 'hal_fact_check')
      .gte('created_at', since24h)
      .limit(5000);

    const observed = new Map<string, { ok: number; bad: number }>();
    if (!error) {
      for (const r of (rows ?? []) as Array<{ provider: string; status: string }>) {
        const e = observed.get(r.provider) ?? { ok: 0, bad: 0 };
        if (r.status === 'success') e.ok += 1;
        else e.bad += 1;
        observed.set(r.provider, e);
      }
    }

    const answered = cfgs.filter((c) => (observed.get(c.name)?.ok ?? 0) > 0);
    const measured = answered.length > 0;
    // Re-run the SAME family audit on the answering subset, rather than deriving families a
    // second way here. Two independent derivations of "what counts as one family" would drift,
    // and this number is the whole differentiator.
    const live = measured ? auditFamilyIndependence(answered) : configured;

    quorum = measured
      ? { providers: answered.length, families: live.families.length, family_names: live.families }
      : { providers: cfgs.length, families: configured.families.length, family_names: configured.families };

    quorumHealth = {
      // 'measured' = counted from calls that happened. 'configured' = nothing to count in the
      // window, so this is what we would ask, not what answered. Never silently one or other.
      basis: measured ? 'measured' : 'configured',
      window_hours: 24,
      configured_providers: cfgs.length,
      configured_families: configured.families.length,
      answering_providers: answered.length,
      // Named so the gap is actionable rather than merely visible. A provider that was asked
      // and never once succeeded in 24h is the shape of a dead model or a dead key.
      not_answering: cfgs
        .filter((c) => (observed.get(c.name)?.ok ?? 0) === 0)
        .map((c) => ({ provider: c.name, calls_failed: observed.get(c.name)?.bad ?? 0 })),
      note: measured
        ? 'Counted from calls in the window. A configured provider that never answered is not a voice in the quorum.'
        : 'No fact-check calls in the window, so this reports the configured set. NOT a measurement that these providers answer.',
    };
  } catch {
    // Leave zeros — the frontend renders an honest fallback, never a mock.
  }

  res.json({
    // Headline counts — what a Magician running curl sees first.
    total_inferences,
    total_classifications,
    audit_chain_length,
    peer_verification_queue_size,
    peer_verification_total,
    peer_verification_last_24h,
    last_24h_inferences,
    last_24h_classifications,

    // Cross-family quorum (live config, not a constant).
    quorum_providers: quorum.providers,
    quorum_families: quorum.families,
    quorum_family_names: quorum.family_names,
    // The provenance of the three numbers above. Read `basis` before quoting them.
    quorum_health: quorumHealth,

    // Per-table breakdown for the curious reader.
    breakdown: {
      hal_classifications: classifications,
      hal_audit_chain: auditChain,
      hal_production_events: {
        ...productionEvents,
        sample: { in_last_1000: sample.lifetime_in_sample, caught: sample.caught_in_sample },
      },
      peer_verification_queue: {
        total: peer_verification_total,
        pending: peer_verification_queue_size,
        last_24h: peer_verification_last_24h,
      },
    },

    // Verifiable external benchmark statistics
    external_benchmark: externalBenchmark,

    // Liveness + latency.
    isLive,
    avg_latency_ms: sample.avg_latency_ms, // measured from the most recent 1000 production events
    network: 'base-sepolia',
    last_updated: new Date().toISOString(),
  });
});

export default router;
