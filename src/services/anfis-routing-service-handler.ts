import { ServiceHandlerBase } from './service-handler-base';
import type { ServiceContractRow } from '../types';
import { db } from '../db';
import { selectSlmRoute, estimateSlmSavings, type SlmModel, type SlmDecision, type SlmSavings } from '../providers/slm-tier';
import { isHealthy } from '../providers/health';

// Nominal token footprint for a classification/quick-check, used to ESTIMATE the
// per-decision SLM cost saving at recommendation time (the actual call + real tokens
// happen downstream). Documented assumption; the savings memo scales by volume.
const SLM_NOMINAL_TOKENS_IN = 500;
const SLM_NOMINAL_TOKENS_OUT = 100;

// An SLM is "available" if its provider is healthy AND its API key is configured.
// If none are available, selectSlmRoute returns null and we fall through to the LLM tier.
function slmAvailable(m: SlmModel): boolean {
  const keyPresent = !!process.env[`${m.provider.toUpperCase()}_API_KEY`];
  return keyPresent && isHealthy(m.provider);
}

/**
 * Phase 2.10 — ANFIS Routing Service Handler (P-002)
 *
 * Advisory: given a query + task characteristics, recommends an LLM provider
 * from historical performance. Patent gate: computeFitnessScore uses abstract
 * feature normalization only — NO ANFIS internal coefficients/weight matrices
 * are committed here.
 */
interface RoutingPayload {
  query: string;
  task_characteristics?: {
    complexity?: 'low' | 'medium' | 'high';
    domain?: string;
    latency_budget_ms?: number;
    cost_budget_usdc_raw?: number;
    // SLM tier inputs (CC1 2026-05-26): when task_type is an SLM-eligible class and the
    // required confidence is below the threshold, ANFIS routes to the ultra-cheap SLM tier.
    task_type?: string;
    confidence_required?: number;
  };
  buyer_provider_preferences?: string[];
}

interface ProviderPerf {
  provider: string;
  hit_rate: number;
  avg_latency_ms: number;
  avg_cost_usdc: number;
  sample_count: number;
}

export class AnfisRoutingServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'anfis_routing';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as RoutingPayload;

    const features = {
      complexity: payload.task_characteristics?.complexity ?? 'medium',
      domain: payload.task_characteristics?.domain ?? 'general',
      latency_budget: payload.task_characteristics?.latency_budget_ms ?? 5000,
      cost_budget: payload.task_characteristics?.cost_budget_usdc_raw ?? 100000,
    };

    // SLM tier (CC1 2026-05-26): for SLM-eligible task classes with a low confidence bar,
    // recommend the ultra-cheap SLM tier below the LLM tier. Falls through to the normal
    // LLM routing below when not eligible or no SLM is available.
    const slm = selectSlmRoute(
      payload.task_characteristics?.task_type,
      payload.task_characteristics?.confidence_required,
      slmAvailable,
    );
    if (slm) {
      const savings = estimateSlmSavings(SLM_NOMINAL_TOKENS_IN, SLM_NOMINAL_TOKENS_OUT, { provider: slm.provider, model: slm.model });
      await this.recordSlmRoute(contract, slm, savings);

      // Write ANFIS routing log (SLM decision)
      try {
        await db.from('anfis_routing_logs').insert({
          request_text: payload.query || 'SLM Routing Decision',
          selected_model: `${slm.provider}/${slm.model}`,
          confidence_score: payload.task_characteristics?.confidence_required ?? 0.5,
          cost_saved: savings.saved_usd,
          latency_ms: 0,
          success: true
        });
      } catch (e: any) {
        console.error('[anfis_routing] recordSlmRoute log failure:', e?.message ?? e);
      }

      return {
        recommended_provider: slm.provider,
        recommended_model: slm.model,
        chosen_tier: '0a',
        confidence: payload.task_characteristics?.confidence_required ?? 0.5,
        fallback_chain: [`${slm.fallback.provider}/${slm.fallback.model}`, 'groq', 'anthropic'],
        reasoning: slm.reason,
        cost_saved_usd_estimate: savings.saved_usd,
        cost_basis: { nominal_tokens_in: SLM_NOMINAL_TOKENS_IN, nominal_tokens_out: SLM_NOMINAL_TOKENS_OUT, baseline: savings.baseline, note: 'recommendation-time estimate at nominal tokens' },
        contract_id: contract.id,
        computed_at: new Date().toISOString(),
        patent_marker: 'P-002',
      };
    }

    const historicalData = await this.queryProviderPerformance(features.domain);

    // Defensive empty-result guard (Phase 2.9.3 Task 2c finding): the RPC
    // returns 0 rows when there is no historical data for the domain.
    if (!historicalData || historicalData.length === 0) {
      // Write ANFIS routing log (fallback decision)
      try {
        await db.from('anfis_routing_logs').insert({
          request_text: payload.query || 'ANFIS Routing Fallback Decision',
          selected_model: 'groq',
          confidence_score: 0.3,
          cost_saved: 0,
          latency_ms: 0,
          success: true
        });
      } catch (e: any) {
        console.error('[anfis_routing] fallback log failure:', e?.message ?? e);
      }

      return {
        recommended_provider: 'groq', // safe default — fastest, cheapest
        confidence: 0.3, // low-confidence flag
        fallback_chain: ['anthropic', 'openai'],
        reasoning: `No historical performance data for domain '${features.domain}' — returning default routing`,
        historical_basis: { sample_size: 0, domain: features.domain },
        contract_id: contract.id,
        computed_at: new Date().toISOString(),
        patent_marker: 'P-002',
      };
    }

    const scored = historicalData.map((p) => ({
      provider: p.provider,
      score: this.computeFitnessScore(p, features),
      historical_hit_rate: p.hit_rate,
      historical_avg_latency_ms: p.avg_latency_ms,
      historical_avg_cost_usdc: p.avg_cost_usdc,
      sample_count: p.sample_count,
    }));

    scored.sort((a, b) => b.score - a.score);

    const recommended = scored[0];
    if (!recommended) {
      // Unreachable (scored mirrors non-empty historicalData) but satisfies
      // noUncheckedIndexedAccess and is a defensive default.
      // Write ANFIS routing log (error/unscoreable decision)
      try {
        await db.from('anfis_routing_logs').insert({
          request_text: payload.query || 'ANFIS Routing Error Decision',
          selected_model: 'groq',
          confidence_score: 0.3,
          cost_saved: 0,
          latency_ms: 0,
          success: true
        });
      } catch (e: any) {
        console.error('[anfis_routing] unscoreable log failure:', e?.message ?? e);
      }

      return {
        recommended_provider: 'groq',
        confidence: 0.3,
        fallback_chain: ['anthropic', 'openai'],
        reasoning: 'No scoreable providers — returning default routing',
        historical_basis: { sample_size: 0, domain: features.domain },
        contract_id: contract.id,
        computed_at: new Date().toISOString(),
        patent_marker: 'P-002',
      };
    }
    const fallback_chain = scored.slice(1, 4).map((s) => s.provider);
    const confidenceScore = Math.min(1, recommended.score);

    // Write ANFIS routing log (scored decision)
    try {
      await db.from('anfis_routing_logs').insert({
        request_text: payload.query || 'ANFIS Routing Scored Decision',
        selected_model: recommended.provider,
        confidence_score: confidenceScore,
        cost_saved: 0,
        latency_ms: 0,
        success: true
      });
    } catch (e: any) {
      console.error('[anfis_routing] scored log failure:', e?.message ?? e);
    }

    return {
      recommended_provider: recommended.provider,
      confidence: confidenceScore,
      fallback_chain,
      reasoning: this.summarizeReasoning(features, recommended),
      historical_basis: {
        sample_size: historicalData.reduce((sum, p) => sum + Number(p.sample_count), 0),
        domain: features.domain,
        provider_count: scored.length,
      },
      contract_id: contract.id,
      computed_at: new Date().toISOString(),
      patent_marker: 'P-002',
    };
  }

  private async queryProviderPerformance(domain: string): Promise<ProviderPerf[]> {
    const { data, error } = await db.rpc('anfis_provider_performance_lookup', {
      p_domain: domain,
      p_window_days: 30,
    });

    if (error) {
      console.error(
        `[anfis_routing] RPC error:`,
        error?.message ?? error,
        (error as any)?.stack ?? new Error().stack
      );
      return [];
    }
    return (data ?? []) as ProviderPerf[];
  }

  /**
   * Cost tracking (Phase 2.2): record the SLM routing decision + estimated saving to the
   * shared usage table, with per-agent attribution. Non-blocking — a logging failure must
   * never break the routing recommendation.
   */
  private async recordSlmRoute(contract: ServiceContractRow, slm: SlmDecision, savings: SlmSavings): Promise<void> {
    try {
      const tc = (contract.payload as RoutingPayload).task_characteristics;
      await db.from('trinity_tool_usage').insert({
        agent_id: (contract as any).buyer_agent_id ?? null,
        tool_name: 'slm_route',
        mcp_call_params: { task_type: tc?.task_type, confidence_required: tc?.confidence_required, recommended: `${slm.provider}/${slm.model}` },
        outcome: { tier: '0a', provider: slm.provider, model: slm.model, savings, contract_id: contract.id },
        latency_ms: 0,
      });
    } catch (e: any) {
      console.error('[anfis_routing] recordSlmRoute failed (non-blocking):', e?.message ?? e);
    }
  }

  /**
   * ABSTRACT FITNESS SCORING — patent-gate compliant. Feature-based
   * normalization only; no ANFIS internal coefficients.
   */
  private computeFitnessScore(
    p: { hit_rate: number; avg_latency_ms: number; avg_cost_usdc: number },
    features: { latency_budget: number; cost_budget: number }
  ): number {
    const latencyFit =
      features.latency_budget >= p.avg_latency_ms
        ? 1.0
        : features.latency_budget / p.avg_latency_ms;
    const costFit =
      features.cost_budget >= p.avg_cost_usdc ? 1.0 : features.cost_budget / p.avg_cost_usdc;
    return p.hit_rate * latencyFit * costFit;
  }

  private summarizeReasoning(
    features: { domain: string },
    recommended: {
      provider: string;
      historical_hit_rate: number;
      historical_avg_latency_ms: number;
      sample_count: number;
    }
  ): string {
    return (
      `Domain '${features.domain}' best served by ${recommended.provider} based on ` +
      `${(recommended.historical_hit_rate * 100).toFixed(1)}% historical hit rate and ` +
      `${Math.round(recommended.historical_avg_latency_ms)}ms median latency ` +
      `(${recommended.sample_count} samples).`
    );
  }
}
