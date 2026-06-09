/**
 * HalService — the reusable HAL evaluation surface every Trust* product calls.
 *
 * Foundation for TrustShell.dev / TrustTrader.dev / TrustCRE.dev: one clean
 * interface, product profiles (strictness + thresholds + domain), env-overridable.
 * Internally dispatches to the calibrated fact-check evaluator (strictness:2) or
 * the extractor (strictness:1). Decoupled from the scoring pipeline / db so it's
 * independently testable and embeddable.
 */
import { factCheck, buildFactCheckProviders, type FactCheckProviderCfg } from './fact-check';
import { evaluate } from './lib/evaluate';

export type Product = 'trustshell' | 'trusttrader' | 'trustcre' | 'default';

export interface HalEvaluationRequest {
  text: string;
  context?: { domain?: string; certainty?: number; product?: Product };
  strictness?: 1 | 2;
}

export interface HalEvaluationResponse {
  hal_score: number;
  decision: 'vetoed' | 'flagged' | 'clean' | 'abstain';
  decision_reason?: string; // A1 — human-readable explanation (verdict mode)
  mode: 'fact-check' | 'extractor' | 'extractor-fallback';
  strictness: 1 | 2;
  product: Product;
  signals: Record<string, unknown>;
  provider_responses?: unknown[];
  latency_ms: number;
}

interface Profile {
  strictness: 1 | 2;
  vetoThreshold: number;
  flagThreshold: number;
  domain: string;
}

/**
 * Product profiles — presets per Trust* domain. All thresholds env-overridable
 * (HAL_VETO_THRESHOLD / HAL_FLAG_THRESHOLD apply globally). Tune per product later.
 */
export const HAL_PROFILES: Record<Product, Profile> = {
  default: { strictness: 2, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'general' },
  trustshell: { strictness: 2, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'technical' },
  trusttrader: { strictness: 2, vetoThreshold: 0.45, flagThreshold: 0.3, domain: 'finance' },
  trustcre: { strictness: 2, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'cre-underwriting' },
};

const deriveDecision = (s: number, vetoed: boolean, sev?: string | null): HalEvaluationResponse['decision'] =>
  vetoed || sev === 'critical' ? 'vetoed' : s >= 0.4 ? 'flagged' : 'clean';

function clamp01(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

export class HalService {
  constructor(private providersFn: () => FactCheckProviderCfg[] = buildFactCheckProviders) {}

  async evaluate(req: HalEvaluationRequest): Promise<HalEvaluationResponse> {
    const start = Date.now();
    const product: Product = req.context?.product && HAL_PROFILES[req.context.product] ? req.context.product : 'default';
    const profile = HAL_PROFILES[product];
    const strictness: 1 | 2 = req.strictness ?? profile.strictness;
    const domain = req.context?.domain ?? profile.domain;
    const certainty = req.context?.certainty ?? 0.8;
    // Env overrides win over profile thresholds (runtime tuning, no redeploy).
    const vetoThreshold = clamp01(process.env.HAL_VETO_THRESHOLD) ?? profile.vetoThreshold;
    const flagThreshold = Math.min(clamp01(process.env.HAL_FLAG_THRESHOLD) ?? profile.flagThreshold, vetoThreshold);

    if (strictness === 2) {
      const providers = this.providersFn();
      if (providers.length > 0) {
        const fc = await factCheck(req.text, providers, { vetoThreshold, flagThreshold });
        if (fc.providers_used > 0) {
          return {
            hal_score: fc.hal_score, decision: fc.decision,
            ...(fc.decision_reason ? { decision_reason: fc.decision_reason } : {}),
            mode: 'fact-check', strictness, product,
            signals: {
              providers_used: fc.providers_used, agreement: fc.agreement, degraded: fc.degraded,
              // R5 — distinct independent families that voted (the quorum unit).
              families_used: fc.families_used, families: fc.families,
              // CC1 2026-05-23 provider-failure hardening: surface quorum + per-provider health.
              quorum: fc.quorum, provider_health: fc.provider_health,
              ...(fc.quorum_note ? { quorum_note: fc.quorum_note } : {}),
            },
            provider_responses: fc.verdicts, latency_ms: Date.now() - start,
          };
        }
      }
      // No providers / none responded → extractor fallback.
      const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
      return {
        hal_score: r.hal_score, decision: deriveDecision(r.hal_score, r.vetoed, (r.signals as any)?.comma_severity ?? null),
        mode: 'extractor-fallback', strictness, product, signals: r.signals as any, latency_ms: Date.now() - start,
      };
    }

    const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
    return {
      hal_score: r.hal_score, decision: deriveDecision(r.hal_score, r.vetoed, (r.signals as any)?.comma_severity ?? null),
      mode: 'extractor', strictness, product, signals: r.signals as any, latency_ms: Date.now() - start,
    };
  }
}

export const halService = new HalService();
