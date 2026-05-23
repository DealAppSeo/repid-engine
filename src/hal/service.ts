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
  decision: 'vetoed' | 'flagged' | 'clean';
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
 *
 * SCALE (fact-check, src/hal/fact-check.ts): hal_score in [0,1] = RISK that the
 * deliverable is FALSE — HIGH score = more likely false (bad). decision:
 * hal_score >= vetoThreshold → vetoed; >= flagThreshold → flagged; else clean.
 * So vetoThreshold > flagThreshold, and a STRICTER domain uses a LOWER vetoThreshold
 * (vetoes more readily). Calibration (20-item corpus): false mean 0.788 / true mean
 * 0.171; veto 0.5 + flag 0.35 → caught_false 9/10, over-veto-true 0/7 (F1 high).
 *
 * NOTE (2026-05-23 reconciliation): MEL's research recommended 0.80-0.85 — same
 * direction (high=risk) but too-HIGH a cutoff (would under-veto, missing false
 * items scoring 0.5-0.79). NOT an inverted scale. Corrected to the calibrated
 * 0.45-0.5 range here. MEL's directional intuition (finance stricter than mixed)
 * is preserved: trusttrader vetoThreshold 0.45 < trustshell 0.5.
 */
export const HAL_PROFILES: Record<Product, Profile> = {
  default: { strictness: 1, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'general' }, // unknown product → fast extractor
  trustshell: { strictness: 2, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'technical' },
  trusttrader: { strictness: 2, vetoThreshold: 0.45, flagThreshold: 0.3, domain: 'finance' }, // stricter: lower veto = vetoes more readily
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
            hal_score: fc.hal_score, decision: fc.decision, mode: 'fact-check', strictness, product,
            signals: { providers_used: fc.providers_used, agreement: fc.agreement, degraded: fc.degraded },
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
