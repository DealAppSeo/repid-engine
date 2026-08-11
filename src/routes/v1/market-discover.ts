/**
 * market-discover — rung 0 of the TrustMarket ladder.
 *
 * `GET /api/v1/market/discover` — **keyless, anonymous, read-only.** Ask "who could do this job,
 * and why should I believe them?" and get a scored, evidenced answer without an account.
 *
 * WHY IT IS PUBLIC. The same reason `/negotiation/rfqs` is: an agent that finds the ecosystem
 * cannot decide whether to join a market it is not allowed to look at. And a reputation surface
 * behind an API key is not a public reputation surface. The proof a surface demands should scale
 * with the value it credits — this one credits nothing, so it demands nothing.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not rank by price, hide its reasoning, or return a
 * bare number. Every candidate carries the dimensions actually used, the ones unavailable, the
 * ones not implemented at all, and the evidence string behind each — so the caller (usually
 * another agent) can re-derive the verdict instead of trusting it. Scoring lives in
 * `src/repid/selection-score.ts`; this route only fetches and shapes.
 *
 * SAFE IN PUBLIC: everything returned is already a public reputation fact — listed price, agent
 * name, earned RepID, completed-job counts, dispute counts, on-chain attestation counts. No keys,
 * no buyer identities, no internal topology.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { rankCandidates, type CandidateEvidence } from '../../repid/selection-score';

const router = Router();

const MAX_LIMIT = 25;

/** USDC is 6-decimal; the table stores raw. Callers think in dollars. */
const usdcToRaw = (dollars: number) => Math.round(dollars * 1_000_000);
const rawToUsdc = (raw: number | null | undefined) =>
  raw === null || raw === undefined ? null : Number((raw / 1_000_000).toFixed(6));

interface ServiceRow {
  id: string;
  provider_agent_id: string;
  service_type: string;
  service_name: string;
  description: string | null;
  base_price_usdc_raw: number;
  total_fulfilled: number | null;
  total_satisfied: number | null;
  avg_satisfaction: number | null;
  capability_metadata: Record<string, unknown> | null;
}

router.get('/discover', async (req: Request, res: Response) => {
  const {
    service_type,
    max_price_usdc,
    min_repid,
    min_coverage,
    q,
    limit,
  } = req.query as Record<string, string | undefined>;

  const take = Math.min(Number(limit) || 10, MAX_LIMIT);

  try {
    let sq = db
      .from('agent_services')
      .select(
        'id, provider_agent_id, service_type, service_name, description, base_price_usdc_raw, total_fulfilled, total_satisfied, avg_satisfaction, capability_metadata',
      )
      .eq('active', true);

    if (service_type) sq = sq.eq('service_type', service_type);
    if (max_price_usdc) sq = sq.lte('base_price_usdc_raw', usdcToRaw(Number(max_price_usdc)));

    const { data: services, error: sErr } = await sq.limit(200);
    if (sErr) return res.status(500).json({ error: sErr.message });

    const rows = (services ?? []) as ServiceRow[];
    if (rows.length === 0) {
      // An empty market is a RESULT, not an error, and it must say why it is empty rather than
      // returning [] and letting the caller assume the filters were too tight.
      return res.json({
        query: { service_type: service_type ?? null, max_price_usdc: max_price_usdc ?? null },
        candidates: [],
        market: { services_considered: 0 },
        note: 'no active services matched — the market is empty for this query, not filtered out',
      });
    }

    const providerIds = [...new Set(rows.map((r) => r.provider_agent_id))];
    const { data: agents, error: aErr } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier, last_active_at')
      .in('id', providerIds);
    if (aErr) return res.status(500).json({ error: aErr.message });

    const agentById = new Map((agents ?? []).map((a: any) => [a.id, a]));

    // Disputes and on-chain attestations, counted per provider. Both are PUBLIC reputation facts.
    const names = (agents ?? []).map((a: any) => a.agent_name).filter(Boolean);
    const { data: disputes } = await db
      .from('dispute_claims')
      .select('defendant_agent, status')
      .in('defendant_agent', names.length ? names : ['__none__']);
    const { data: attestations } = await db
      .from('erc8004_reputation_writes')
      .select('agent_id')
      .in('agent_id', providerIds);

    const disputeTotal = new Map<string, number>();
    const disputeLost = new Map<string, number>();
    for (const d of (disputes ?? []) as any[]) {
      disputeTotal.set(d.defendant_agent, (disputeTotal.get(d.defendant_agent) ?? 0) + 1);
      if (d.status === 'resolved') {
        disputeLost.set(d.defendant_agent, (disputeLost.get(d.defendant_agent) ?? 0) + 1);
      }
    }
    const attCount = new Map<string, number>();
    for (const w of (attestations ?? []) as any[]) {
      attCount.set(w.agent_id, (attCount.get(w.agent_id) ?? 0) + 1);
    }

    // Optional free-text narrowing over the listing itself. Deliberately a plain substring match,
    // NOT a relevance score: pretending to rank by semantic similarity when we have no embeddings
    // would be exactly the fabricated dimension the scorer refuses to emit.
    const needle = (q ?? '').trim().toLowerCase();
    const matches = needle
      ? rows.filter((r) =>
          `${r.service_name} ${r.description ?? ''} ${JSON.stringify(r.capability_metadata ?? {})}`
            .toLowerCase()
            .includes(needle),
        )
      : rows;

    const minRepid = min_repid ? Number(min_repid) : 0;
    const byService = new Map<string, ServiceRow>();
    const evidence: CandidateEvidence[] = [];

    for (const r of matches) {
      const a = agentById.get(r.provider_agent_id);
      if (!a) continue;
      if (a.current_repid < minRepid) continue;
      // One entry per (service) — the same provider may list several.
      byService.set(r.id, r);
      evidence.push({
        agentId: r.id, // the SERVICE is what gets hired, so it is the unit of selection
        agentName: a.agent_name,
        currentRepid: a.current_repid,
        totalFulfilled: r.total_fulfilled ?? 0,
        avgSatisfaction: r.avg_satisfaction,
        catastrophicFailures: disputeLost.get(a.agent_name) ?? 0,
        disputesTotal: disputeTotal.get(a.agent_name) ?? 0,
        // Settlement history is not yet queryable per-provider without a join we do not have a
        // verified column for — passed as null so the scorer reports it UNAVAILABLE rather than
        // scoring it as zero. Reporting ignorance beats inventing a number.
        settlementsSettled: null,
        onchainAttestations: attCount.get(r.provider_agent_id) ?? 0,
        lastActivityAt: a.last_active_at ?? null,
      });
    }

    const ranked = rankCandidates(evidence, Date.now(), {
      minCoverage: min_coverage ? Number(min_coverage) : 0,
    }).slice(0, take);

    return res.json({
      query: {
        service_type: service_type ?? null,
        max_price_usdc: max_price_usdc ? Number(max_price_usdc) : null,
        min_repid: minRepid || null,
        min_coverage: min_coverage ? Number(min_coverage) : null,
        q: q ?? null,
      },
      market: {
        services_considered: rows.length,
        services_matching_filters: matches.length,
        candidates_scored: evidence.length,
      },
      candidates: ranked.map((s) => {
        const svc = byService.get(s.agentId)!;
        return {
          service_id: svc.id,
          service_name: svc.service_name,
          service_type: svc.service_type,
          price_usdc: rawToUsdc(svc.base_price_usdc_raw),
          provider: s.agentName,
          score: Number(s.score.toFixed(4)),
          coverage: Number(s.coverage.toFixed(4)),
          dimensions_used: s.dimensionsUsed.map((d) => ({
            dimension: d.dimension,
            value: Number(d.value.toFixed(4)),
            weight: d.weight,
            evidence: d.evidence,
          })),
          dimensions_unavailable: s.dimensionsUnavailable,
          dimensions_not_implemented: s.dimensionsNotImplemented,
          failure_penalty: s.failurePenalty,
          notes: s.notes,
        };
      }),
      // Stated on every response so a consumer never mistakes a thin score for a confident one.
      interpretation:
        'score is a weighted mean over the dimensions actually evidenced; coverage is the fraction ' +
        'of implementable weight that was evidenced. Compare scores only at comparable coverage. ' +
        'Dimensions listed as unavailable or not_implemented were OMITTED, never defaulted.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'discovery failed' });
  }
});

export default router;
