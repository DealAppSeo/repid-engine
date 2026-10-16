import { Router, Request, Response } from 'express';
import { db } from '../db';
import { buildFactCheckProviders, auditFamilyIndependence } from '../hal/fact-check';
import { SEALED_RULER_VERSIONS, rulerIdFor, sealedRunRuler } from '../hal/sealed-ruler';
import { recordMeasurement } from '../hal/measurement-ruler';

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

  // EXTERNAL BENCHMARK — an F1 is published only WITH its ruler (CLAUDE_RULES r24, 2026-10-16).
  //
  // ~80% of hal_test_cases is now a readable library, so a score on it measures recall of published
  // answers. Accuracy is measured on the sealed ruler (src/hal/sealed-ruler.ts). The latest run is
  // published only when its rows carry a sealed ruler tag that names a registered version with its
  // pinned hash and scored exactly that version's N cases. Otherwise the number is WITHHELD: no
  // F1, no confusion counts, just the run's identity and the reason. Every run recorded before the
  // sealed ruler carries harness_version '1.0.0', so today this withholds.
  //
  // The matrix comes from the run's own `correct` column (the labels the ruler hash was taken
  // over), not from today's hal_test_cases, so a later relabel cannot silently change a published
  // number.
  const getExternalBenchmark = async () => {
    try {
      const { data: latest, error: latestErr } = await db
        .from('hal_external_validation_runs')
        .select('run_id, run_at')
        .order('run_at', { ascending: false })
        .limit(1);
      if (latestErr || !latest || latest.length === 0) return null;
      const runId = latest[0]!.run_id;
      const measuredAt = latest[0]!.run_at;

      const { data: rows, error: rowsErr } = await db
        .from('hal_external_validation_runs')
        .select('test_case_id, hal_decision, correct, harness_version')
        .eq('run_id', runId);
      if (rowsErr || !rows) return null;

      const identity = {
        run_id: runId,
        measured_at: measuredAt,
        measurement_age_days: Math.floor((Date.now() - new Date(measuredAt).getTime()) / 86_400_000),
      };
      const withheld = (reason: string) => ({
        status: 'not_measured_on_sealed_ruler' as const,
        note: 'not measured on a sealed ruler yet',
        reason,
        ...identity,
        ruler: null,
        citation: null,
        metrics: null,
      });

      const verdict = sealedRunRuler(
        rows.map((r: any) => r.harness_version),
        rows.map((r: any) => String(r.test_case_id)),
      );
      if (!verdict.ok) return withheld(verdict.reason);
      if (rows.some((r: any) => typeof r.correct !== 'boolean')) return withheld('run rows are missing their correctness label');

      const matrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
      for (const r of rows as Array<{ hal_decision: string; correct: boolean }>) {
        const vetoed = r.hal_decision === 'vetoed';
        if (vetoed) r.correct ? matrix.tp++ : matrix.fp++;
        else r.correct ? matrix.tn++ : matrix.fn++;
      }
      const k = verdict.parsed;
      const pin = SEALED_RULER_VERSIONS.find((v) => rulerIdFor(v.version) === verdict.rulerId)!.pin;
      const m = recordMeasurement({
        matrix,
        ruler: {
          corpus: {
            corpusId: k.corpusId,
            contentHash: k.contentHash,
            caseCount: pin.caseCount,
            positiveCount: matrix.tp + matrix.fn,
            builtAt: new Date(measuredAt).toISOString(),
            sources: [{ source: 'hal_external_validation_runs', caseCount: rows.length, note: String(runId) }],
          },
          width: {
            // The stored tag records the observed width, not the configured one.
            familiesConfigured: Math.max(1, k.familiesMax),
            familiesMin: k.familiesMin,
            familiesMax: k.familiesMax,
            strictness: k.strictness,
            decisionRequiresQuorum: k.decisionRequiresQuorum,
            penaltyRequiresQuorum: k.penaltyRequiresQuorum,
          },
        },
      });
      const pct = (x: number | null) => (x === null ? null : +(x * 100).toFixed(2));
      return {
        status: 'measured' as const,
        ...identity,
        ruler: {
          id: k.corpusId,
          content_hash: k.contentHash,
          n: pin.caseCount,
          families_observed_min: k.familiesMin,
          families_observed_max: k.familiesMax,
          strictness: k.strictness,
          decision_requires_quorum: k.decisionRequiresQuorum,
          penalty_requires_quorum: k.penaltyRequiresQuorum,
        },
        citation: m.citation,
        metrics_unit: 'percent',
        metrics: {
          ...matrix,
          precision: pct(m.metrics.precision),
          recall: pct(m.metrics.recall),
          f1_score: pct(m.metrics.f1),
          accuracy: pct(m.metrics.accuracy),
        },
        reproduction_command: `npm run hal:score-external -- --ruler ${k.corpusId}`,
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

    // External benchmark: published only with its sealed ruler; otherwise withheld with the reason.
    external_benchmark: externalBenchmark,

    // Liveness + latency.
    isLive,
    avg_latency_ms: sample.avg_latency_ms, // measured from the most recent 1000 production events
    network: 'base-sepolia',
    last_updated: new Date().toISOString(),
  });
});

export default router;
