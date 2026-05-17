import { ServiceHandlerBase } from './service-handler-base';
import type { ServiceContractRow } from '../types';
import { db } from '../db';

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

    const historicalData = await this.queryProviderPerformance(features.domain);

    // Defensive empty-result guard (Phase 2.9.3 Task 2c finding): the RPC
    // returns 0 rows when there is no historical data for the domain.
    if (!historicalData || historicalData.length === 0) {
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

    return {
      recommended_provider: recommended.provider,
      confidence: Math.min(1, recommended.score),
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
