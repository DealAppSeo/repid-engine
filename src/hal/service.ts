/**
 * HalService — the reusable HAL evaluation surface every Trust* product calls.
 *
 * Foundation for TrustShell.dev / TrustTrader.dev / TrustCRE.dev: one clean
 * interface, product profiles (strictness + thresholds + domain), env-overridable.
 * Internally dispatches to the calibrated fact-check evaluator (strictness:2) or
 * the extractor (strictness:1). Decoupled from the scoring pipeline / db so it's
 * independently testable and embeddable.
 */
import { factCheck, buildFactCheckProviders, buildUniversalProviders, type FactCheckProviderCfg, type FactCheckResult } from './fact-check';
import { evaluate } from './lib/evaluate';
import { queryOpenAI } from './lib/openai';

export type Product = 'trustshell' | 'trusttrader' | 'trustcre' | 'default';

export interface HalEvaluationRequest {
  text: string;
  context?: { domain?: string; certainty?: number; product?: Product; grounded_context?: string };
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
  // GLASS BOX — SBFA v0.2 belief/ignorance/confidence + the structured human-readable decision trace.
  // Surfaced to the wrapper verdict event + the HITL PWA. Present only on the fact-check (strictness-2) path.
  sbfa?: FactCheckResult['sbfa'];
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
  default: { strictness: 2, vetoThreshold: 0.43, flagThreshold: 0.35, domain: 'general' },
  trustshell: { strictness: 2, vetoThreshold: 0.43, flagThreshold: 0.35, domain: 'technical' },
  trusttrader: { strictness: 2, vetoThreshold: 0.43, flagThreshold: 0.3, domain: 'finance' },
  trustcre: { strictness: 2, vetoThreshold: 0.43, flagThreshold: 0.35, domain: 'cre-underwriting' },
};

const deriveDecision = (s: number, vetoed: boolean, sev?: string | null, isExtractor?: boolean): HalEvaluationResponse['decision'] =>
  !isExtractor && (vetoed || sev === 'critical') ? 'vetoed' : s >= 0.4 ? 'flagged' : 'clean';

function clamp01(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

const ROUTER_SYSTEM = 
  "You are an expert claim classifier. You must classify the given statement/claim into one of three routes:\n" +
  "1. \"ABSTAIN\": Subjective claims, opinions, creative writing, preferences, or topics with no single objective ground truth.\n" +
  "   Examples: \"The best programming language is Python\", \"Write a story about a dragon\", \"I love chocolate ice cream\".\n" +
  "2. \"FACT\": Checkable factual claims, single-hop statements, or time-sensitive facts that can be verified with external references.\n" +
  "   Examples: \"Murda Beatz is from Ontario\", \"The capital of France is Paris\", \"Microsoft's stock price today is $420\".\n" +
  "3. \"REASONING\": Logical reasoning, math, arithmetic, code correctness, puzzles, or multi-hop logical claims that must be solved using reasoning rather than static facts.\n" +
  "   Examples: \"2+2=4\", \"If A is taller than B and B is taller than C...\", \"The following code implements quicksort...\".\n\n" +
  "Output ONLY a JSON object (no markdown, no prose):\n" +
  "{\"route\": \"ABSTAIN|FACT|REASONING\", \"rationale\": \"one sentence explanation\"}";

export async function routeClaim(text: string): Promise<{ route: 'ABSTAIN' | 'FACT' | 'REASONING'; rationale: string }> {
  try {
    const raw = await queryOpenAI(`Classify this claim:\n"${text}"`, ROUTER_SYSTEM, true);
    const parsed = JSON.parse(raw);
    const route = String(parsed.route).toUpperCase();
    if (route === 'ABSTAIN' || route === 'FACT' || route === 'REASONING') {
      return { route: route as any, rationale: parsed.rationale || '' };
    }
    return { route: 'FACT', rationale: 'Fallback due to invalid route value' };
  } catch (e: any) {
    console.error("[router] classification failed, fallback to FACT:", e.message);
    return { route: 'FACT', rationale: `Router error: ${e.message}` };
  }
}

const RETRIEVER_SYSTEM =
  "You are a factual knowledge retriever. For the given claim, return 3 short, high-fidelity factual context snippets (max 2 sentences each) that are highly relevant to verifying the claim.\n" +
  "Output ONLY the snippets separated by double newlines.";

export async function retrieveContext(text: string): Promise<string[]> {
  try {
    const raw = await queryOpenAI(`Retrieve factual snippets for:\n"${text}"`, RETRIEVER_SYSTEM, false);
    const snippets = raw
      .split('\n\n')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .slice(0, 3);
    return snippets;
  } catch (e: any) {
    console.error("[retriever] context retrieval failed:", e.message);
    return [];
  }
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
      // Category-aware gating: opinion is exempt from truth-veto;
      // time-sensitive routes to freshness/recency checks, not a truth-veto.
      if (domain === 'opinion' || domain === 'time-sensitive') {
        return {
          hal_score: 0.0,
          decision: 'clean',
          mode: 'fact-check',
          strictness,
          product,
          signals: {
            route: 'ABSTAIN',
            rationale: `Category '${domain}' is exempt from truth-veto (opinion or time-sensitive recency routing).`,
            decision: 'clean',
          },
          latency_ms: Date.now() - start,
        };
      }

      // 1. Run Domain Router
      const { route, rationale } = await routeClaim(req.text);

      if (route === 'ABSTAIN') {
        // Subjective claims abstain cleanly, no veto
        return {
          hal_score: 0.0,
          decision: 'clean',
          mode: 'fact-check',
          strictness,
          product,
          signals: {
            route,
            rationale,
            decision: 'clean',
          },
          latency_ms: Date.now() - start,
        };
      }

      // 2. Build Providers (Universal/Active Quorum by default)
      let providers = buildUniversalProviders(route);
      if (process.env.HAL_UNIVERSAL_TRUTHFULNESS === 'false') {
        providers = this.providersFn();
      }

      if (providers.length > 0) {
        // 3. Conditional Retrieval
        let contextStr: string | undefined;
        let retrievedSnippets: string[] | undefined;
        let contextSource: 'model_recalled' | 'grounded' | 'unverified' = 'unverified';

        if (route === 'FACT') {
          if (req.context?.grounded_context) {
            contextStr = req.context.grounded_context;
            retrievedSnippets = [contextStr];
            contextSource = 'grounded';
          } else {
            retrievedSnippets = await retrieveContext(req.text);
            if (retrievedSnippets && retrievedSnippets.length > 0) {
              contextStr = retrievedSnippets.join('\n\n');
              contextSource = 'model_recalled';
            } else {
              contextSource = 'unverified';
            }
          }
        }

        const fc = await factCheck(req.text, providers, { vetoThreshold, flagThreshold, contextSource, category: route.toLowerCase() } as any, contextStr);
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
              route, rationale,
              context_source: contextSource,
              ...(contextSource === 'model_recalled'
                ? { recalled_snippets: retrievedSnippets }
                : { retrieved_snippets: retrievedSnippets }
              ),
              evidence: fc.evidence,
              ...(fc.quorum_note ? { quorum_note: fc.quorum_note } : {}),
            },
            provider_responses: fc.verdicts, latency_ms: Date.now() - start,
            ...(fc.sbfa ? { sbfa: fc.sbfa } : {}),
          };
        }
      }
      // No providers / none responded → extractor fallback.
      const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
      return {
        hal_score: r.hal_score, decision: deriveDecision(r.hal_score, r.vetoed, (r.signals as any)?.comma_severity ?? null, true),
        mode: 'extractor-fallback', strictness, product, signals: { ...r.signals as any, route: 'FALLBACK' }, latency_ms: Date.now() - start,
      };
    }

    const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
    return {
      hal_score: r.hal_score, decision: deriveDecision(r.hal_score, r.vetoed, (r.signals as any)?.comma_severity ?? null, true),
      mode: 'extractor', strictness, product, signals: r.signals as any, latency_ms: Date.now() - start,
    };
  }
}

export const halService = new HalService();

