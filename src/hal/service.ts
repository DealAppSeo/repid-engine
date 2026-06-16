/**
 * HalService — the reusable HAL evaluation surface every Trust* product calls.
 *
 * Foundation for TrustShell.dev / TrustTrader.dev / TrustCRE.dev: one clean
 * interface, product profiles (strictness + thresholds + domain), env-overridable.
 * Internally dispatches to the calibrated fact-check evaluator (strictness:2) or
 * the extractor (strictness:1). Decoupled from the scoring pipeline / db so it's
 * independently testable and embeddable.
 *
 * B1 — STAKES-GATING SHADOW LOG (2026-06-16, CC). Flag-gated (HAL_STAKES_GATING_SHADOW, default ON).
 * On EVERY evaluate() call, classifies the call as 'standard' or 'contested/high-stakes' and
 * shadow-logs which path WOULD be taken by a full stakes-gating router. SHADOW-ONLY: this log
 * NEVER changes which providers run or the verdict. Wiring the actual expensive-path trigger is
 * co-sign-gated (GA design + A6). The SBFA signal `escalate_to: 'contested_bft'` (already produced
 * by sbfa-consensus.ts, surfaced in fact-check.ts) is the downstream "contested" indicator; the
 * stakes input comes from the caller's context.certainty + the fact-check quorum state.
 *
 * B3 — CALIBRATION-MAP HOOK (2026-06-16, CC). Identity passthrough by default, ready for GA's
 * Phase-2 calibration map. Pattern mirrors setSbfaTelemetrySink in fact-check.ts. Default: the
 * map is identity (rawScore → rawScore). GA calls setCalibrationMap() to install the real map.
 * Wired at the score-emit point (just before returning). The map is applied AFTER the fact-check
 * scores are aggregated; GA's calibration is a monotone transform over [0,1] → [0,1] and must
 * not change which providers ran or the quorum logic.
 */
import { factCheck, buildFactCheckProviders, type FactCheckProviderCfg, type FactCheckResult } from './fact-check';
import { evaluate } from './lib/evaluate';

// ---------------------------------------------------------------------------
// B3 — Calibration-map seam (identity by default; GA installs the real map).
// ---------------------------------------------------------------------------
export type CalibrationMapFn = (rawScore: number) => number;

let _calibrationMap: CalibrationMapFn = (s) => s; // identity passthrough

/**
 * Install a calibration map that post-processes the raw hal_score before it is
 * returned from evaluate(). The map MUST be monotone-non-decreasing over [0,1] and
 * MUST return a value in [0,1]. Default: identity (no-op). GA calls this to install
 * the Phase-2 isotonic/Platt calibration map.
 */
export function setCalibrationMap(fn: CalibrationMapFn): void {
  _calibrationMap = fn;
}

/** Reset to identity (useful in tests). */
export function resetCalibrationMap(): void {
  _calibrationMap = (s) => s;
}

/**
 * Apply the registered calibration map, clamping to [0,1].
 * Called at the score-emit point inside evaluate() — NEVER inside factCheck or
 * the extractor — so the quorum/verdict logic always operates on the raw score
 * (the map is for human-facing output only).
 */
export function applyCalibrationMap(rawScore: number): number {
  try {
    const mapped = _calibrationMap(rawScore);
    if (!Number.isFinite(mapped)) return rawScore; // guard: map must return finite
    return Math.max(0, Math.min(1, mapped));
  } catch {
    return rawScore; // calibration map must never crash the live path
  }
}

// ---------------------------------------------------------------------------
// B1 — Stakes-gating shadow log (SHADOW ONLY; no routing change).
// ---------------------------------------------------------------------------
/** Classification of a call for the shadow stakes-gating router. */
export type StakesGatingPath = 'standard' | 'contested' | 'high-stakes';

export interface StakesGatingShadowRow {
  /** Timestamp (ISO). */
  ts: string;
  /** Classified routing path. */
  path: StakesGatingPath;
  /** SBFA escalate_to signal from the fact-check result (when available). */
  sbfa_escalate_to: 'contested_bft' | null;
  /** Whether the quorum was degraded (< 2 independent families). */
  degraded: boolean;
  /** The stakes hint from the caller's context (certainty proxy). */
  certainty: number;
  /** The product profile — higher-stakes products get contested classification earlier. */
  product: string;
  /** Raw hal_score BEFORE calibration map. */
  raw_score: number;
  /** live decision (not changed by shadow). */
  live_decision: string;
}

export type StakesGatingShadowSink = (row: StakesGatingShadowRow) => void;
let _stakesShadowSink: StakesGatingShadowSink = (row) => {
  console.log(
    `[stakes-gating-shadow] path=${row.path} sbfa_escalate=${row.sbfa_escalate_to ?? 'none'} ` +
    `degraded=${row.degraded} score=${row.raw_score.toFixed(3)} decision=${row.live_decision} ` +
    `product=${row.product} certainty=${row.certainty.toFixed(2)}`
  );
};

/** Replace the default console sink (e.g. GA DB writer). */
export function setStakesGatingShadowSink(sink: StakesGatingShadowSink): void {
  _stakesShadowSink = sink;
}

/**
 * Classify a HAL call as standard vs contested vs high-stakes.
 *
 * Rules (mirror GA's intended design from SBFA §2.4 + D-056 measurement notes):
 * - contested:   SBFA says escalate_to='contested_bft' OR quorum was degraded AND score ≥ 0.35
 * - high-stakes: product is trusttrader/trustcre OR certainty ≥ 0.9 AND score ≥ 0.4
 * - standard:    everything else (the cheap Gate-OFF path, the vast majority of traffic)
 *
 * This classification is SHADOW ONLY. It does not alter routing.
 */
export function classifyStakesGating(opts: {
  sbfa_escalate_to: 'contested_bft' | null;
  degraded: boolean;
  certainty: number;
  product: string;
  raw_score: number;
}): StakesGatingPath {
  const { sbfa_escalate_to, degraded, certainty, product, raw_score } = opts;
  // Explicit contested signal from SBFA (the system itself flagged a deadlock).
  if (sbfa_escalate_to === 'contested_bft') return 'contested';
  // Degraded quorum AND score is in the veto zone → contested (uncertain, not a clean clean).
  if (degraded && raw_score >= 0.35) return 'contested';
  // High-stakes products (money/RE) OR very high certainty with a meaningful score.
  if (product === 'trusttrader' || product === 'trustcre') return 'high-stakes';
  if (certainty >= 0.9 && raw_score >= 0.4) return 'high-stakes';
  return 'standard';
}

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
          // B3 — calibration-map hook: apply after quorum/verdict logic, before returning.
          const calibratedScore = applyCalibrationMap(fc.hal_score);

          // B1 — stakes-gating shadow log (SHADOW ONLY; no routing change).
          if (process.env.HAL_STAKES_GATING_SHADOW !== 'false') {
            const sbfa_escalate_to = fc.sbfa?.escalate_to ?? null;
            const path = classifyStakesGating({
              sbfa_escalate_to,
              degraded: fc.degraded,
              certainty,
              product,
              raw_score: fc.hal_score,
            });
            setImmediate(() => {
              try {
                _stakesShadowSink({
                  ts: new Date().toISOString(),
                  path,
                  sbfa_escalate_to,
                  degraded: fc.degraded,
                  certainty,
                  product,
                  raw_score: fc.hal_score,
                  live_decision: fc.decision,
                });
              } catch { /* shadow must never crash the live path */ }
            });
          }

          return {
            hal_score: calibratedScore, decision: fc.decision,
            ...(fc.decision_reason ? { decision_reason: fc.decision_reason } : {}),
            mode: 'fact-check', strictness, product,
            signals: {
              providers_used: fc.providers_used, agreement: fc.agreement, degraded: fc.degraded,
              // R5 — distinct independent families that voted (the quorum unit).
              families_used: fc.families_used, families: fc.families,
              // CC1 2026-05-23 provider-failure hardening: surface quorum + per-provider health.
              quorum: fc.quorum, provider_health: fc.provider_health,
              ...(fc.quorum_note ? { quorum_note: fc.quorum_note } : {}),
              // B3 — expose whether calibration changed the score (useful for GA telemetry).
              calibration_applied: calibratedScore !== fc.hal_score,
            },
            provider_responses: fc.verdicts, latency_ms: Date.now() - start,
            ...(fc.sbfa ? { sbfa: fc.sbfa } : {}),
          };
        }
      }
      // No providers / none responded → extractor fallback.
      const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
      const rawScore = r.hal_score;
      const calibratedScore = applyCalibrationMap(rawScore);

      // B1 shadow log for extractor-fallback path.
      if (process.env.HAL_STAKES_GATING_SHADOW !== 'false') {
        const fallbackDecision = deriveDecision(rawScore, r.vetoed, (r.signals as any)?.comma_severity ?? null);
        setImmediate(() => {
          try {
            _stakesShadowSink({
              ts: new Date().toISOString(),
              path: classifyStakesGating({ sbfa_escalate_to: null, degraded: true, certainty, product, raw_score: rawScore }),
              sbfa_escalate_to: null,
              degraded: true,
              certainty,
              product,
              raw_score: rawScore,
              live_decision: fallbackDecision,
            });
          } catch { /* shadow must never crash */ }
        });
      }

      return {
        hal_score: calibratedScore, decision: deriveDecision(rawScore, r.vetoed, (r.signals as any)?.comma_severity ?? null),
        mode: 'extractor-fallback', strictness, product, signals: r.signals as any, latency_ms: Date.now() - start,
      };
    }

    const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
    const rawScore = r.hal_score;
    const calibratedScore = applyCalibrationMap(rawScore);
    const extDecision = deriveDecision(rawScore, r.vetoed, (r.signals as any)?.comma_severity ?? null);

    // B1 shadow log for extractor path.
    if (process.env.HAL_STAKES_GATING_SHADOW !== 'false') {
      setImmediate(() => {
        try {
          _stakesShadowSink({
            ts: new Date().toISOString(),
            path: classifyStakesGating({ sbfa_escalate_to: null, degraded: false, certainty, product, raw_score: rawScore }),
            sbfa_escalate_to: null,
            degraded: false,
            certainty,
            product,
            raw_score: rawScore,
            live_decision: extDecision,
          });
        } catch { /* shadow must never crash */ }
      });
    }

    return {
      hal_score: calibratedScore, decision: extDecision,
      mode: 'extractor', strictness, product, signals: r.signals as any, latency_ms: Date.now() - start,
    };
  }
}

export const halService = new HalService();
